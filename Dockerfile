# Use an official Node.js 20 image as the base
FROM node:20-slim

# Set the working directory inside the container
WORKDIR /app

# Install system dependencies: ffmpeg, yt-dlp, and git
RUN apt-get update && apt-get install -y \
    ffmpeg \
    git \
    wget \
    --no-install-recommends && \
    \
    wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    \
    rm -rf /var/lib/apt/lists/*

# Copy package.json and package-lock.json
COPY package*.json ./

# Install your app's Node.js dependencies
RUN npm install

# Copy the rest of your application code
COPY . .

# Expose the port your app runs on
EXPOSE 3000

# The command to run your app
CMD [ "npm", "start" ]
