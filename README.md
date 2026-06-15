services:
  - type: web
    name: trench-beanz-server
    runtime: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
    # Keeps the leaderboard.json file between deploys so scores don't vanish.
    # (Free plan note: the disk persists across deploys but the service still
    #  sleeps after ~15 min idle and wakes on the next visit.)
    disk:
      name: trench-data
      mountPath: /var/data
      sizeGB: 1
    envVars:
      - key: LB_FILE
        value: /var/data/leaderboard.json
