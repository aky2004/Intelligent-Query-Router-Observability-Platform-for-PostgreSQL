import net from "net";
import { executeQuery } from "../router/query-router";
import type { QueryResult } from "../types/query";
import { logger } from "../utils/logger";
import { uuid } from "../utils/helpers";

interface PreparedStatement {
  sql: string;
  paramOids: number[];
}

interface Portal {
  sql: string;
  params: unknown[];
  result?: QueryResult;
  error?: Error;
}

/**
 * Creates a buffer for a PostgreSQL backend message with standard [type][length][payload] header.
 */
function createMessage(type: string, payload: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeInt32BE(payload.length + 4, 0);
  return Buffer.concat([typeBuf, lenBuf, payload]);
}

/**
 * Creates an AuthenticationOk message ('R', 0).
 */
function authOkMessage(): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeInt32BE(0, 0); // Auth type 0 = Ok
  return createMessage("R", payload);
}

/**
 * Creates a ParameterStatus message ('S').
 */
function parameterStatusMessage(name: string, value: string): Buffer {
  const nameBuf = Buffer.from(name + "\0", "utf8");
  const valBuf = Buffer.from(value + "\0", "utf8");
  return createMessage("S", Buffer.concat([nameBuf, valBuf]));
}

/**
 * Creates a BackendKeyData message ('K').
 */
function backendKeyDataMessage(pid: number, secret: number): Buffer {
  const payload = Buffer.alloc(8);
  payload.writeInt32BE(pid, 0);
  payload.writeInt32BE(secret, 4);
  return createMessage("K", payload);
}

/**
 * Creates a ReadyForQuery message ('Z').
 */
function readyForQueryMessage(status = "I"): Buffer {
  return createMessage("Z", Buffer.from(status, "ascii"));
}

/**
 * Creates an ErrorResponse message ('E').
 */
function errorResponseMessage(message: string, code = "XX000"): Buffer {
  const parts: Buffer[] = [
    Buffer.from("S", "ascii"), Buffer.from("ERROR\0", "utf8"),
    Buffer.from("C", "ascii"), Buffer.from(code + "\0", "utf8"),
    Buffer.from("M", "ascii"), Buffer.from(message + "\0", "utf8"),
    Buffer.from("\0", "ascii"),
  ];
  return createMessage("E", Buffer.concat(parts));
}

/**
 * Creates a RowDescription message ('T') from field names and sample row.
 */
function rowDescriptionMessage(fields: string[], sampleRow?: Record<string, unknown>): Buffer {
  const countBuf = Buffer.alloc(2);
  countBuf.writeInt16BE(fields.length, 0);
  const parts: Buffer[] = [countBuf];

  for (const field of fields) {
    const nameBuf = Buffer.from(field + "\0", "utf8");
    const metaBuf = Buffer.alloc(18);
    metaBuf.writeInt32BE(0, 0);  // Table OID
    metaBuf.writeInt16BE(0, 4);  // Column attr num
    
    // Infer basic data type OID
    let typeOid = 25; // default text
    if (sampleRow && sampleRow[field] !== undefined && sampleRow[field] !== null) {
      const val = sampleRow[field];
      if (typeof val === "number") typeOid = Number.isInteger(val) ? 23 : 701; // int4 or float8
      else if (typeof val === "boolean") typeOid = 16; // bool
      else if (val instanceof Date) typeOid = 1114; // timestamp
      else if (typeof val === "object") typeOid = 3802; // jsonb
    }

    metaBuf.writeInt32BE(typeOid, 6); // Type OID
    metaBuf.writeInt16BE(-1, 10);     // Type size (-1 for variable)
    metaBuf.writeInt32BE(-1, 12);     // Type modifier
    metaBuf.writeInt16BE(0, 16);      // Format code (0 = text)

    parts.push(nameBuf, metaBuf);
  }

  return createMessage("T", Buffer.concat(parts));
}

/**
 * Creates a DataRow message ('D').
 */
function dataRowMessage(fields: string[], row: Record<string, unknown>): Buffer {
  const countBuf = Buffer.alloc(2);
  countBuf.writeInt16BE(fields.length, 0);
  const parts: Buffer[] = [countBuf];

  for (const field of fields) {
    const val = row[field];
    if (val === null || val === undefined) {
      const nullBuf = Buffer.alloc(4);
      nullBuf.writeInt32BE(-1, 0); // -1 length = NULL
      parts.push(nullBuf);
    } else {
      let strVal: string;
      if (typeof val === "boolean") {
        // PostgreSQL wire protocol text format: 't' or 'f' (NOT 'true'/'false')
        // The pg client's boolean parser does `val === 't'`, so 'true' would parse as false!
        strVal = val ? "t" : "f";
      } else if (typeof val === "object") {
        if (val instanceof Date) {
          // PostgreSQL timestamp format: 'YYYY-MM-DD HH:MM:SS.mmm' not ISO 'Z' format
          strVal = val.toISOString().replace("T", " ").replace("Z", "");
        } else {
          strVal = JSON.stringify(val);
        }
      } else {
        strVal = String(val);
      }
      const valBuf = Buffer.from(strVal, "utf8");
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeInt32BE(valBuf.length, 0);
      parts.push(lenBuf, valBuf);
    }
  }

  return createMessage("D", Buffer.concat(parts));
}

/**
 * Creates a CommandComplete message ('C').
 */
function commandCompleteMessage(sql: string, rowCount: number): Buffer {
  const trimmed = sql.trim().toUpperCase();
  let tag = "SELECT 0";
  if (trimmed.startsWith("INSERT")) tag = `INSERT 0 ${rowCount}`;
  else if (trimmed.startsWith("UPDATE")) tag = `UPDATE ${rowCount}`;
  else if (trimmed.startsWith("DELETE")) tag = `DELETE ${rowCount}`;
  else if (trimmed.startsWith("SELECT")) tag = `SELECT ${rowCount}`;
  else if (trimmed.startsWith("CREATE")) tag = "CREATE TABLE";
  else if (trimmed.startsWith("DROP")) tag = "DROP TABLE";
  else if (trimmed.startsWith("ALTER")) tag = "ALTER TABLE";
  else if (trimmed.startsWith("SET")) tag = "SET";
  else if (trimmed.startsWith("SHOW")) tag = "SHOW";
  else if (trimmed.startsWith("BEGIN") || trimmed.startsWith("START")) tag = "BEGIN";
  else if (trimmed.startsWith("COMMIT")) tag = "COMMIT";
  else if (trimmed.startsWith("ROLLBACK")) tag = "ROLLBACK";
  else tag = `OK ${rowCount}`;

  const payload = Buffer.from(tag + "\0", "utf8");
  return createMessage("C", payload);
}

/**
 * Starts the PostgreSQL Wire Protocol TCP Proxy Server.
 */
export function startPgProxyServer(port = 5433): net.Server {
  const server = net.createServer((socket) => {
    const sessionId = `pgwire-${uuid().slice(0, 8)}`;
    const pid = Math.floor(Math.random() * 100000);
    const secretKey = Math.floor(Math.random() * 1000000000);
    
    let handshakeDone = false;
    let rxBuffer = Buffer.alloc(0);

    const statements = new Map<string, PreparedStatement>();
    const portals = new Map<string, Portal>();

    socket.on("data", async (chunk) => {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);

      try {
        while (rxBuffer.length > 0) {
          // Handshake phase
          if (!handshakeDone) {
            if (rxBuffer.length < 8) return; // Wait for full packet length header
            const len = rxBuffer.readInt32BE(0);
            if (rxBuffer.length < len) return;

            const packet = rxBuffer.subarray(0, len);
            rxBuffer = rxBuffer.subarray(len);

            const code = packet.readInt32BE(4);
            if (code === 80877103) {
              // SSLRequest: reply 'N' (SSL not supported on this direct proxy socket, client will fall back to plaintext)
              socket.write(Buffer.from("N", "ascii"));
              continue;
            }

            // Regular StartupMessage (Protocol 3.0: 0x00030000 = 196608)
            handshakeDone = true;
            
            // Send initial startup sequence
            const msgs: Buffer[] = [
              authOkMessage(),
              parameterStatusMessage("server_version", "16.0 (pg-router-ai)"),
              parameterStatusMessage("server_encoding", "UTF8"),
              parameterStatusMessage("client_encoding", "UTF8"),
              parameterStatusMessage("application_name", "pg-router-ai"),
              parameterStatusMessage("is_superuser", "on"),
              parameterStatusMessage("session_authorization", "postgres"),
              parameterStatusMessage("standard_conforming_strings", "on"),
              parameterStatusMessage("integer_datetimes", "on"),
              backendKeyDataMessage(pid, secretKey),
              readyForQueryMessage("I"),
            ];
            socket.write(Buffer.concat(msgs));
            continue;
          }

          // Message processing phase
          if (rxBuffer.length < 5) return;
          const msgType = String.fromCharCode(rxBuffer[0]);
          const msgLen = rxBuffer.readInt32BE(1);
          const totalLen = msgLen + 1; // type (1 byte) + length field (4 bytes) + payload

          if (rxBuffer.length < totalLen) return; // Wait for full message
          const msgBody = rxBuffer.subarray(5, totalLen);
          rxBuffer = rxBuffer.subarray(totalLen);

          // Handle message types
          switch (msgType) {
            // 'Q' = Simple Query
            case "Q": {
              const nullIdx = msgBody.indexOf(0);
              const sql = msgBody.subarray(0, nullIdx >= 0 ? nullIdx : undefined).toString("utf8");
              
              if (!sql || !sql.trim()) {
                socket.write(Buffer.concat([
                  createMessage("I", Buffer.alloc(0)), // EmptyQueryResponse
                  readyForQueryMessage("I"),
                ]));
                break;
              }

              try {
                const { result } = await executeQuery(sql, [], { sessionId });
                const rows = result.rows ?? [];
                const fields = result.fields?.length ? result.fields : (rows[0] ? Object.keys(rows[0]) : []);

                const resMsgs: Buffer[] = [];
                if (fields.length > 0) {
                  resMsgs.push(rowDescriptionMessage(fields, rows[0]));
                  for (const row of rows) {
                    resMsgs.push(dataRowMessage(fields, row));
                  }
                }
                resMsgs.push(commandCompleteMessage(sql, result.rowCount ?? rows.length));
                resMsgs.push(readyForQueryMessage("I"));
                socket.write(Buffer.concat(resMsgs));
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                socket.write(Buffer.concat([
                  errorResponseMessage(errMsg),
                  readyForQueryMessage("I"),
                ]));
              }
              break;
            }

            // 'P' = Parse (Extended Protocol)
            case "P": {
              let offset = 0;
              const nameEnd = msgBody.indexOf(0, offset);
              const stmtName = msgBody.subarray(offset, nameEnd).toString("utf8");
              offset = nameEnd + 1;

              const sqlEnd = msgBody.indexOf(0, offset);
              const sql = msgBody.subarray(offset, sqlEnd).toString("utf8");
              offset = sqlEnd + 1;

              const numParams = msgBody.readInt16BE(offset);
              offset += 2;
              const paramOids: number[] = [];
              for (let i = 0; i < numParams; i++) {
                paramOids.push(msgBody.readInt32BE(offset));
                offset += 4;
              }

              statements.set(stmtName, { sql, paramOids });
              socket.write(createMessage("1", Buffer.alloc(0))); // ParseComplete ('1')
              break;
            }

            // 'B' = Bind (Extended Protocol)
            case "B": {
              let offset = 0;
              const portalEnd = msgBody.indexOf(0, offset);
              const portalName = msgBody.subarray(offset, portalEnd).toString("utf8");
              offset = portalEnd + 1;

              const stmtEnd = msgBody.indexOf(0, offset);
              const stmtName = msgBody.subarray(offset, stmtEnd).toString("utf8");
              offset = stmtEnd + 1;

              const stmt = statements.get(stmtName);

              // Read per-parameter format codes (0 = text, 1 = binary)
              // When numFormats=0: all params are text
              // When numFormats=1: that one format applies to ALL params
              // When numFormats=N: each param has its own format code
              const numFormats = msgBody.readInt16BE(offset);
              offset += 2;
              const formatCodes: number[] = [];
              for (let i = 0; i < numFormats; i++) {
                formatCodes.push(msgBody.readInt16BE(offset));
                offset += 2;
              }
              const getFormatCode = (i: number): number => {
                if (numFormats === 0) return 0; // all text
                if (numFormats === 1) return formatCodes[0]!; // one code applies to all
                return formatCodes[i] ?? 0; // per-param format
              };

              const numParams = msgBody.readInt16BE(offset);
              offset += 2;
              const params: unknown[] = [];
              for (let i = 0; i < numParams; i++) {
                const pLen = msgBody.readInt32BE(offset);
                offset += 4;
                if (pLen === -1) {
                  params.push(null);
                } else {
                  const valBytes = msgBody.subarray(offset, offset + pLen);
                  offset += pLen;
                  const isBinary = getFormatCode(i) === 1;
                  if (isBinary) {
                    // Binary-encoded integer (e.g. LIMIT $N sent as 4-byte big-endian int)
                    if (pLen === 4) {
                      params.push(valBytes.readInt32BE(0));
                    } else if (pLen === 8) {
                      params.push(Number(valBytes.readBigInt64BE(0)));
                    } else if (pLen === 2) {
                      params.push(valBytes.readInt16BE(0));
                    } else if (pLen === 1) {
                      params.push(valBytes.readInt8(0));
                    } else {
                      // Unknown binary type — fall back to hex string
                      params.push(valBytes.toString("hex"));
                    }
                  } else {
                    // Text-encoded parameter — decode as UTF-8
                    const str = valBytes.toString("utf8");
                    if (/^-?\d+$/.test(str) && !str.startsWith("0")) {
                      const num = Number(str);
                      params.push(Number.isSafeInteger(num) ? num : str);
                    } else {
                      params.push(str);
                    }
                  }
                }
              }

              const sql = stmt?.sql ?? "";
              const portalData: Portal = { sql, params };

              if (sql) {
                try {
                  const { result } = await executeQuery(sql, params, { sessionId });
                  portalData.result = result;
                } catch (err) {
                  portalData.error = err instanceof Error ? err : new Error(String(err));
                }
              }

              portals.set(portalName, portalData);
              socket.write(createMessage("2", Buffer.alloc(0))); // BindComplete ('2')
              break;
            }

            // 'D' = Describe
            case "D": {
              const descType = String.fromCharCode(msgBody[0]);
              const descName = msgBody.subarray(1, msgBody.indexOf(0, 1)).toString("utf8");
              const portal = descType === "P" ? portals.get(descName) : [...portals.values()].at(-1);

              if (descType === "S") {
                const numParams = statements.get(descName)?.paramOids.length ?? 0;
                const pBuf = Buffer.alloc(2 + numParams * 4);
                pBuf.writeInt16BE(numParams, 0);
                socket.write(createMessage("t", pBuf)); // ParameterDescription ('t')
              }

              const rows = portal?.result?.rows ?? [];
              const fields = portal?.result?.fields?.length ? portal.result.fields : (rows[0] ? Object.keys(rows[0]) : []);

              if (fields.length > 0) {
                socket.write(rowDescriptionMessage(fields, rows[0]));
              } else {
                socket.write(createMessage("n", Buffer.alloc(0))); // NoData ('n')
              }
              break;
            }

            // 'E' = Execute
            case "E": {
              const portalEnd = msgBody.indexOf(0, 0);
              const portalName = msgBody.subarray(0, portalEnd).toString("utf8");
              const portal = portals.get(portalName);

              if (portal?.error) {
                socket.write(errorResponseMessage(portal.error.message));
                break;
              }

              if (!portal || !portal.sql) {
                socket.write(commandCompleteMessage("SELECT", 0));
                break;
              }

              const result = portal.result;
              const rows = result?.rows ?? [];
              const fields = result?.fields?.length ? result.fields : (rows[0] ? Object.keys(rows[0]) : []);

              const resMsgs: Buffer[] = [];
              for (const row of rows) {
                resMsgs.push(dataRowMessage(fields, row));
              }
              resMsgs.push(commandCompleteMessage(portal.sql, result?.rowCount ?? rows.length));
              socket.write(Buffer.concat(resMsgs));
              break;
            }

            // 'S' = Sync
            case "S": {
              socket.write(readyForQueryMessage("I"));
              break;
            }

            // 'X' = Terminate
            case "X": {
              socket.end();
              break;
            }

            default: {
              break;
            }
          }
        }
      } catch (e) {
        logger.error("Error in PG Wire protocol handler", { error: String(e) });
        socket.write(Buffer.concat([
          errorResponseMessage(e instanceof Error ? e.message : "Internal proxy error"),
          readyForQueryMessage("I"),
        ]));
      }
    });

    socket.on("error", (err) => {
      if ((err as any).code !== "ECONNRESET") {
        logger.debug("PG Wire socket error", { error: err.message });
      }
    });
  });

  server.listen(port, () => {
    logger.info("PostgreSQL Wire Protocol Proxy listening", {
      port,
      protocol: "pgwire (v3.0)",
    });
  });

  return server;
}
