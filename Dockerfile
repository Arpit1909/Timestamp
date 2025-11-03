# Use an official Node.js 20 image as the base
FROM node:20-slim

# Set the working directory inside the container
WORKDIR /app

# Install system dependencies: ffmpeg, yt-dlp, and python
# Removed 'git' as it's not a runtime dependency
RUN apt-get update && apt-get install -y \
    ffmpeg \
    wget \
    ca-certificates \
    python3 \
    --no-install-recommends && \
    \
    # Now, install the LATEST yt-dlp binary directly
    wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    \
    # Clean up apt cache
    rm -rf /var/lib/apt/lists/*

# Copy package.json and package-lock.json
COPY package*.json ./

# Install your app's Node.js dependencies (production only)
RUN npm ci --production || npm install --production

# Copy the rest of your application code
# (This will respect the .dockerignore file)
COPY . .

# Create a non-root user and group
RUN addgroup --system node && adduser --system --group node
RUN chown -R node:node /app

# Declare volumes for persistent data
# This signals that 'data/jobs' and 'shared' should be mounted
VOLUME /app/data/jobs
VOLUME /app/shared

# Run as the non-root user
USER node

# Expose the port your app runs on
EXPOSE 3000

# The command to run your app
CMD [ "npm", "start" ]