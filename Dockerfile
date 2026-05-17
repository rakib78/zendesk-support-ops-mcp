# Use Node.js LTS image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build the project
RUN npm run build

# Expose port (adjust if your app uses a different port)
EXPOSE 3000

# Set environment variables (these can be overridden at runtime)
ENV NODE_ENV=production

# Start the application
CMD ["npm", "start"]
