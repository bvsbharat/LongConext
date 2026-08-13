export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, initialDelay = 1000): Promise<T> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await fn();
    } catch (error: any) {
      attempt++;
      if (attempt >= maxRetries || (error?.status !== 503 && error?.status !== 429)) {
        throw error;
      }
      const delay = initialDelay * Math.pow(2, attempt - 1);
      console.warn(`Retry attempt ${attempt} after ${delay}ms due to error: ${error?.message || error}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error("Unreachable");
}
