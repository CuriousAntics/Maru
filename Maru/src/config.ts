export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function snowflake(name: string): string {
  const value = required(name);
  if (!/^\d{17,20}$/.test(value)) throw new Error(`Invalid Discord ID: ${name}`);
  return value;
}

export function port(): number {
  const value = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  return value;
}
