# App driver — headless visual inspection

Logs into the web app as `sim_player_1@pickleague.test` (password `pickle123`)
with a headless Chromium, opens a deep-linked screen, and screenshots it.
Used together with the toolbox flow simulator to WATCH tournaments fill in
round-by-round — this workflow caught the seeds-not-persisted advancement bug.

```bash
cd tools/app-driver && npm install && npx playwright install chromium
# start the web app first: cd mobile && npx expo start --web --port 8095
node driver.mjs "tournaments/<tournamentId>" my-shot          # viewport 430x3000
SHOT_H=3800 node driver.mjs "tournaments/<id>" tall-shot      # taller capture
```

Screenshots land in `shots/`. Session persists to `state.json` after the first
login. Pass the URL path WITHOUT a leading slash (Git Bash mangles it).
