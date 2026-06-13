# Stage 1: Build TypeScript application
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./

RUN npm install

COPY src ./src

RUN npm run build

# Stage 2: Production runtime
FROM node:20-alpine

# Install curl for healthcheck
RUN apk add --no-cache curl

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 8080

CMD ["node", "dist/index.js"]
