export const DEFAULT_PORT = 3000;

export function readPort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_PORT;
  const port = Number(value);
  if (!/^\d+$/.test(value.trim()) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a whole number from 1 to 65535, not "${value}".`);
  }
  return port;
}
