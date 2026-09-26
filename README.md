# Email Service

## Overview

Email Service is built using NestJS, Prisma, MySQL, RabbitMQ, and SendGrid.

Features:

* SendGrid Email Sending
* Sender Rotation
* Email Logging
* SendGrid Event Webhooks
* Webhook Event Tracking
* MySQL Persistence
* RabbitMQ Integration (In Progress)

---

## Tech Stack

* NestJS
* Prisma ORM
* MySQL
* RabbitMQ
* SendGrid

---

## Environment Variables

Create a `.env` file:

env
DATABASE_URL=mysql://username:password@localhost:3306/email_service

SENDGRID_API_KEY=YOUR_SENDGRID_API_KEY


---

## Installation

bash
npm install


---

## Prisma Setup

bash
npx prisma generate

npx prisma migrate dev


---

## Run Application

bash
npm run start:dev


Application runs on:

text
http://localhost:3000


---

## Send Email API

bash
curl --location 'http://localhost:3000/sendgrid/send' \
--header 'Content-Type: application/json' \
--data-raw '{
  "recipientEmail": "test@example.com",
  "subject": "Email Service Test",
  "bodyContent": "<h1>Hello from Email Service</h1>"
}'


---

## Webhook Configuration

Expose local server using ngrok:

bash
ngrok http 3000


Configure SendGrid Event Webhook URL:

text
https://your-ngrok-url.ngrok-free.app/webhooks/sendgrid


---

## Database Tables

### sender_accounts

Stores sender identities and sender rotation information.

### email_logs

Stores outgoing email history and status.

### webhook_events

Stores SendGrid webhook tracking events.

### email_templates

Stores reusable email templates.

---

## Current Flow

text
API Request
    ↓
Sender Selection
    ↓
Email Log Created
    ↓
SendGrid Email Sent
    ↓
Email Log Updated
    ↓
SendGrid Webhook Received
    ↓
Webhook Event Stored

