import { SysLog } from "@/lib/types";
import { File, Paths } from "expo-file-system";

const LOG_FILE_NAME = "system-logs.txt";
const LOCATION_FILE_NAME = "location-logs.txt";

export const formatTimestamp = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `[${yy}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
};

export function appendSystemLog(log: SysLog): void {
  const file = new File(Paths.document, LOG_FILE_NAME);

  if (!file.exists) {
    file.create();
  }

  const timestamp = formatTimestamp(new Date());
  const logLine = `${timestamp}[${log.log_type}][${log.event_name}]: ${log.message}`;
  const existing = file.textSync();
  file.write(existing + logLine + "\n");
}

export function readSystemLogs(): string {
  const file = new File(Paths.document, LOG_FILE_NAME);
  if (!file.exists) return "";
  return file.textSync();
}

export function clearSystemLogs(): void {
  const file = new File(Paths.document, LOG_FILE_NAME);
  if (file.exists) file.delete();
}

// ==================================================================

export function appendLog(log: SysLog): void {
  const file = new File(Paths.document, LOCATION_FILE_NAME);

  if (!file.exists) {
    file.create();
  }

  const timestamp = formatTimestamp(new Date());
  const logLine = `${timestamp}[${log.log_type}][${log.event_name}]: ${log.message}`;
  const existing = file.textSync();
  file.write(existing + logLine + "\n");
}

export function readLogs(): string {
  const file = new File(Paths.document, LOCATION_FILE_NAME);
  if (!file.exists) return "";
  return file.textSync();
}

export function clearLogs(): void {
  const file = new File(Paths.document, LOCATION_FILE_NAME);
  if (file.exists) file.delete();
}
