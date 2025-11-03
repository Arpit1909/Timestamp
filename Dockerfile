# Use an official Node.js 20 image as the base
FROM node:20-slim

# Set the working directory inside the container
WORKDIR /app

# Install system dependencies: ffmpeg, yt-dlp, and git
RUN apt-get update && apt-get install -y \
    ffmpeg \
    yt-dlp \
    git \
    --no-install-recommends && \
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
