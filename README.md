# Uncle Nathan 2.0 — Pilot Build

Private family social-deduction game.

Pilot fixes:
- persistent player identity across reloads and tabs in the same browser
- existing players can rejoin after the game starts
- no duplicate seats from reconnecting
- secret character disappears after submission
- two-player testing allowed
- correct guess keeps the turn
- wrong guess passes the turn to the accused player
- eliminated players cannot act
- automatic game end when one player remains
- winner announced to everyone
- host can start a New Game with the same room/player group

Note: room state is still stored in server memory. A Render process restart will erase active rooms.
