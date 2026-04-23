FROM node:20-slim

# Install dependencies for pdf-parse (poppler-utils)
RUN apt-get update && apt-get install -y \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source
COPY server/ ./server/
COPY public/ ./public/
COPY data/ ./data/

# Create directories
RUN mkdir -p data/temp data/books

# Expose port
EXPOSE 3000

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Start command
CMD ["node", "server/index.js"]