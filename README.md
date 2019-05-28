# Racetracker backend
Firebase backend for the race tracker

Exports an endpoint that recieves the updates from the participants, cleans the data and stores it into Firebase (for realtime visualization) and BigQuery (for deeper analysis). 

## Deploy and execute
To deploy and execute the `saveDeviceData` function, follow these steps:

1. Run this command to deploy your functions:
```
$ firebase deploy --only functions
```

3. Send some sample data to the `saveDeviceData` endpoint:
```
curl -X POST -H "Content-Type:application/json" saveDeviceData -d \
'{
  "temperature": 27.5,
  "time": 1559039878,
  "payload_fields": {
    "longitude": "-41.29126",
    "latitude": "-124.92659",
    "altitude": "23",
    "battery": "73",
    "status": "204",
    "nsat": "3"
  },
  "gateways": {
    "rssi": [3, 4, 5, 7],
    "snr": [12, 10, 9, 11]
  }
 }'
```
