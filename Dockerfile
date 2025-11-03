# Use an official Node.js 20 image as the base
FROM node:20-slim

# Set the working directory inside the container
WORKDIR /app

# Install system dependencies: ffmpeg, yt-dlp, and python
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

# Copy package.json and package-lock.json (if it exists)
COPY package*.json ./

# Install dependencies using the more flexible 'npm install'
# --omit=dev is the modern equivalent of --production
RUN npm install --omit=dev

# Copy the rest of your application code
# (This will respect the .dockerignore file)
COPY . .

# --- FIX 1: User 'node' already exists, so we just use it ---
# Give the existing 'node' user ownership of the app directory
RUN chown -R node:node /app

# Declare volumes for persistent data
VOLUME /app/data/jobs
VOLUME /app/shared

# Run as the non-root user
USER node

# Expose the port your app runs on
EXPOSE 3000

# The command to run your app
CMD [ "npm", "start" ]
