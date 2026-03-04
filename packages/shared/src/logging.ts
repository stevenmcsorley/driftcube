type LogLevel = "debug" | "info" | "warn" | "error";

function write(level: LogLevel, service: string, message: string, meta?: Record<string, unknown>): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    service,
    message,
    ...meta,
  };

  const line = JSON.stringify(payload);
  if (level === "error" || level === "warn") {
    console.error(line);
    return;
  }

  console.log(line);
}

export function createLogger(service: string) {
  return {
    debug(message: string, meta?: Record<string, unknown>) {
      write("debug", service, message, meta);
    },
    info(message: string, meta?: Record<string, unknown>) {
      write("info", service, message, meta);
    },
    warn(message: string, meta?: Record<string, unknown>) {
      write("warn", service, message, meta);
    },
    error(message: string, meta?: Record<string, unknown>) {
      write("error", service, message, meta);
    },
  };
}

