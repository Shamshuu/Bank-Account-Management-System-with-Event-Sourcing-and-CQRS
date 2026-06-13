// src/config.ts
import dotenv from 'dotenv';
import path from 'path';

// Load environmental variables
dotenv.config();

export interface Config {
  API_PORT: number;
  DATABASE_URL: string;
  DB_USER?: string;
  DB_PASSWORD?: string;
  DB_NAME?: string;
}

const getEnvOrThrow = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Environment variable ${key} is required but missing`);
  }
  return value;
};

export const config: Config = {
  API_PORT: parseInt(process.env.API_PORT || '8080', 10),
  DATABASE_URL: getEnvOrThrow('DATABASE_URL'),
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD,
  DB_NAME: process.env.DB_NAME,
};
