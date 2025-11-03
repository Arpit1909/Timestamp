# Use an official Node.js runtime as a parent image
FROM node:14-slim

# Set the working directory inside the container
WORKDIR /app

# Copy the package.json and package-lock.json (if present) to the container
COPY package*.json ./

# Install dependencies
RUN npm install --production --legacy-peer-deps

# Create a non-root user and group if not already present
RUN getent group node || addgroup --system node && \
    getent passwd node || adduser --system --group node

# Change ownership of the app directory to the node user
RUN chown -R node:node /app

# Set the user to 'node' (non-root) to run the app
USER node

# Copy the rest of the application code to the container
COPY . .

# Expose the port the app will run on
EXPOSE 3000

# Run the application
CMD ["npm", "start"]
