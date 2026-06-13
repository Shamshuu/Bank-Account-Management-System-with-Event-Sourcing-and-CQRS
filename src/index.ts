// src/index.ts
import express, { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { apiRouter } from './api';
import { projectorManager } from './projector';
import { pool } from './db';

const app = express();

// Parse JSON request body
app.use(express.json());

// Mount API routes
app.use('/api', apiRouter);

// Health check endpoint (used by Docker Compose healthcheck)
app.get('/health', async (req: Request, res: Response) => {
  try {
    // Basic database check to verify connection viability
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
  } catch (error: any) {
    console.error('Health check failed:', error);
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

// Root route
app.get('/', (req: Request, res: Response) => {
  res.json({
    name: 'Bank Account Management System API',
    version: '1.0.0',
    documentation: '/api/docs',
  });
});

// Global Error Handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start the server
const server = app.listen(config.API_PORT, async () => {
  console.log(`Application server running on port ${config.API_PORT}`);

  try {
    // Initialise the projections (runs catch-up)
    await projectorManager.init();
    console.log('Projections manager initialized successfully');
  } catch (err) {
    console.error('Failed to initialize projections on startup:', err);
  }
});

// Graceful Shutdown
const shutdown = async () => {
  console.log('Received shutdown signal. Stopping server...');
  server.close(async () => {
    console.log('HTTP server stopped.');
    try {
      await pool.end();
      console.log('Database pool closed.');
      process.exit(0);
    } catch (err) {
      console.error('Error closing database pool:', err);
      process.exit(1);
    }
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
