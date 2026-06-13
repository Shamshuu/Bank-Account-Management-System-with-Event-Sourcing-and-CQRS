// src/db.ts
import { Pool, PoolClient } from 'pg';
import { config } from './config';

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
});

// Test the database connection and log connection info
pool.on('connect', () => {
  console.log('Database connected successfully');
});

pool.on('error', (err) => {
  console.error('Unexpected database client error', err);
});

export const db = {
  query: (text: string, params?: any[]) => pool.query(text, params),
  
  getClient: (): Promise<PoolClient> => pool.connect(),
  
  async tx<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
};
