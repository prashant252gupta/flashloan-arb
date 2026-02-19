# Start from a small Node.js base image
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install production dependencies only
RUN npm ci --production

# Bundle app source
COPY . .

# Default command: run the bot
CMD ["node", "bot.js"]
