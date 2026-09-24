import winston from "winston";

const level = process.env.LOG_LEVEL ?? "info";

export const logger = winston.createLogger({
  level,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json(),
  ),
  defaultMeta: { service: "pg-router-ai" },
  transports: [
    new winston.transports.Console({
      format:
        process.env.NODE_ENV === "production"
          ? winston.format.json()
          : winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
  ],
});
