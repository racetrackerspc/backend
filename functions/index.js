
const functions = require('firebase-functions');
const bigquery = require('@google-cloud/bigquery')();
const admin = require('firebase-admin');

admin.initializeApp();

const nearestPointOnLine = require('@turf/nearest-point-on-line').default;
const tj = require('@mapbox/togeojson');
const _ = require('lodash');

const DOMParser = require('xmldom').DOMParser;
const path = require('path');
const fs = require('fs');
const os = require('os');

const config = functions.config();
const db = admin.database();

let raceTrack;


function updateFirebase(data) {
  if (data.properties.longitude) {
    return db.ref(config.paths.participants).child(data.properties.deviceId).set(data);
  }
  return null;
}

function addToBigquery(data) {
  const dataset = bigquery.dataset(config.bigquery.datasetname);
  const table = dataset.table(config.bigquery.tablename);

  return table.insert(data);
}

function sameLocation(oldPayload, newPayload) {
  return (oldPayload.longitude === newPayload.longitude) &&
         (oldPayload.latitude === newPayload.latitude);
}


function snapParticipants(participants) {
  let leaderboard = {};

  for (const id in participants) {
    let snap = nearestPointOnLine(raceTrack, participants[id]);

    Object.assign(snap.properties, participants[id].properties);
    leaderboard[id] = snap;
  }

  return leaderboard;
}


exports.saveDeviceData = functions.https.onRequest((req, res) => {
  const rawData = req.body;

  console.log('saveDeviceData', rawData);

  let deviceId = rawData.dev_id;
  let status = rawData.payload_fields.status;

  let maxRSSI = Math.max(_.map(rawData.metadata.gateways, 'rssi'));
  let maxSNR = Math.max(_.map(rawData.metadata.gateways, 'snr'));

  let payload = {
    temperature: rawData.payload_fields.temperature,
    timestamp: rawData.metadata.time,
    longitude: rawData.payload_fields.longitude,
    latitude: rawData.payload_fields.latitude,
    altitude: rawData.payload_fields.altitude,
    deviceId: rawData.dev_id,
    battery: rawData.payload_fields.battery,
    status: rawData.payload_fields.status,
    nsat: rawData.payload_fields.nsat,
    rssi: maxRSSI,
    snr: maxSNR,
  };

  payload = JSON.parse(JSON.stringify(payload));

  db.ref(config.paths.participants).child(deviceId).once('value', data => {
    let oldGeojson = data.val();

    if (oldGeojson) {
      let oldPayload = oldGeojson.properties;

      if ((status === 205) || (status === 207)) {
        payload.longitude = oldPayload.longitude;
        payload.latitude = oldPayload.latitude;
        payload.lastMove = oldPayload.timestamp;

      } else if (status === 204) {
        if (sameLocation(oldPayload, payload)) {
          payload.lastMove = oldPayload.timestamp;
        } else {
          payload.lastMove = payload.timestamp;
        }
      }
    }

    let geojson = {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [payload.longitude, payload.latitude]
      },
      properties: payload
    };

    return Promise.all([
      updateFirebase(geojson),
      addToBigquery(payload)
    ])
    .then(() =>  res.status(200).send({ status: 'OK' }));
  });
});


exports.updateLeaderboard = functions.https.onRequest((req, res) => {
  const filePath = req.body.filePath;
  const fileName = path.basename(filePath);

  const tempFilePath = path.join(os.tmpdir(), fileName);
  const bucket = admin.storage().bucket();

  let participants;

  db.ref(config.paths.participants)
  .once('value', data => participants = data.val())
  .then(() => {
    if (!raceTrack) {
      console.log(`Loading "${fileName}"`);
      return bucket.file(filePath).download({ destination: tempFilePath })
      .then(() => raceTrack = JSON.parse(fs.readFileSync(tempFilePath, 'utf8')))
      .then(() => fs.unlinkSync(tempFilePath));
    }
    console.log(`"${fileName}" already loaded`);
    return;
  })
  .then(() => snapParticipants(participants))
  .then(leaderboard => db.ref(config.paths.leaderboard).set(leaderboard))
  .then(() => res.status(200).send({ status: 'OK' }));
});


exports.generateGeoJSON = functions.storage.object().onFinalize((object) => {
  const contentType = object.contentType;
  const filePath = object.name;
  const fileName = path.basename(filePath);

  if (!fileName.endsWith('.gpx')) {
    console.log(fileName, 'is not a GPX file');
    return null;
  }

  const tempFilePath = path.join(os.tmpdir(), fileName);
  const metadata = { contentType: contentType };
  const bucket = admin.storage().bucket();

  return bucket.file(filePath).download({ destination: tempFilePath })
  .then(() => {
    console.log('GPX file downloaded locally to', tempFilePath);

    let content = fs.readFileSync(tempFilePath, 'utf8');
    let gpx = new DOMParser().parseFromString(content);
    let geo = tj.gpx(gpx);

    return fs.writeFileSync(tempFilePath, JSON.stringify(geo));
  })
  .then(() => {
    const geoJSONfileName = fileName.replace('.gpx', '.geojson');
    const geoJSONfilePath = path.join(path.dirname(filePath), geoJSONfileName);

    console.log('GeoJSON file created at', geoJSONfilePath);

    return bucket.upload(tempFilePath, {
      destination: geoJSONfilePath,
      metadata: metadata
    });
  })
  .then(() => fs.unlinkSync(tempFilePath));
});
