# Who Picked It? — Family Version

A face-to-face social game. The website replaces only the board and moderator.

## What it does
- One player creates a room.
- A large QR code + 4-character code appear.
- Everyone else joins from their phone.
- Each player enters a name and secretly submits a character.
- Duplicate characters are allowed.
- The board shows remaining players and remaining characters.
- On a wrong guess, the turn passes to the chosen player.
- On a correct guess, that player is eliminated and the successful guesser keeps the turn.
- No visible history of previous guesses.
- Hebrew + English, including RTL.
- Large phone-friendly type.
- No accounts.

## Run locally
Requires Node.js 18+.

```bash
npm install
npm start
```

Then open http://localhost:3000

## Deploy
This is a normal Node web app and can be deployed to Render, Railway, Fly.io, or any Node host.
The start command is:

```bash
npm start
```

The host must expose the `PORT` environment variable (the app already supports it).

### Important
This first family build keeps active rooms in server memory. If the host restarts, the room disappears. For a family game session this is usually fine.
