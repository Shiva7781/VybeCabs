export interface AppConfig {
  port: number;
  mongodbUri: string;
  redis: {
    host: string;
    port: number;
  };
  allocation: {
    radiusKmRounds: number[];
    candidatesPerRound: number;
    timeoutMs: number;
    maxRounds: number;
  };
}

export default (): AppConfig => {
  const radiusKmRounds = (process.env.ALLOCATION_RADIUS_KM_ROUNDS ?? '3,6,10')
    .split(',')
    .map((v) => parseFloat(v.trim()))
    .filter((v) => !Number.isNaN(v));

  return {
    port: parseInt(process.env.PORT ?? '3000', 10),
    mongodbUri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/vybe_cabs',
    redis: {
      host: process.env.REDIS_HOST ?? 'localhost',
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    },
    allocation: {
      radiusKmRounds,
      candidatesPerRound: parseInt(process.env.ALLOCATION_CANDIDATES_PER_ROUND ?? '5', 10),
      timeoutMs: parseInt(process.env.ALLOCATION_TIMEOUT_MS ?? '15000', 10),
      maxRounds: radiusKmRounds.length,
    },
  };
};
