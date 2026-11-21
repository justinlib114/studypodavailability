# Study Pods Dashboard

A staff-facing dashboard for monitoring study pod availability and managing reservations at Greenburgh Public Library. It shows which pods are available or reserved, along with current, upcoming, and recently ended reservations.

## Features

- View pod availability for a selected date range of up to 31 days.
- See reservation times, patron details, check-in status, and a countdown for active reservations.
- Check patrons in or out directly from the dashboard.
- Send a temporary overtime alert for a pod.
- Refresh the information manually or let the dashboard update automatically every minute.

## How it works

The dashboard is served by a Node.js and Express backend. When it loads or refreshes, the browser requests pod and reservation information from the app. The backend authenticates with LibCal, retrieves the pod listings and bookings, and combines them to determine each pod’s current status and its relevant reservations. The browser then displays that information in a table.

Check-in and check-out actions are sent through the backend to LibCal. API credentials are read from server-side environment variables rather than included in the browser app.

## Technology

- JavaScript, HTML, and CSS
- Node.js and Express
- LibCal API
