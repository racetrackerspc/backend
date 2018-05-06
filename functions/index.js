
const functions = require('firebase-functions');
const bigquery = require('@google-cloud/bigquery')();
const admin = require('firebase-admin');

admin.initializeApp();

const nearestPointOnLine = require('@turf/nearest-point-on-line').default;
const tj = require('@mapbox/togeojson');
const _ = {
  isEmpty: require('lodash.isempty'),
  map: require('lodash.map')
};

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


function loadRaceTrack(filePath) {
  const fileName = path.basename(filePath);
  const tempFilePath = path.join(os.tmpdir(), fileName);
  const bucket = admin.storage().bucket();

  console.log(`loadRaceTrack "${fileName}"`);

  return bucket.file(filePath).download({ destination: tempFilePath })
    .then(() => raceTrack = JSON.parse(fs.readFileSync(tempFilePath, 'utf8')))
    .then(() => fs.unlinkSync(tempFilePath));
}


function snapParticipants(participants) {
  let leaderboard = {};

  for (const id in participants) {
    let snap = nearestPointOnLine(raceTrack, participants[id]);
    snap.properties.location *= -1

    Object.assign(snap.properties, participants[id].properties);
    leaderboard[id] = snap;
  }

  return leaderboard;
}


function createFeaturePoint(payload, lastFeaturePoint) {
  if (lastFeaturePoint) {
    let lastPayload = lastFeaturePoint.properties;
    let status = payload.status;

    if ([205, 207].includes(status)) {
      payload.longitude = lastPayload.longitude;
      payload.latitude = lastPayload.latitude;
      payload.lastMove = lastPayload.timestamp;

    } else if (status === 204) {
      if (sameLocation(lastPayload, payload)) {
        payload.lastMove = lastPayload.timestamp;
      } else {
        payload.lastMove = payload.timestamp;
      }
    }
  }

  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [payload.longitude, payload.latitude]
    },
    properties: payload
  };
}


exports.saveDeviceData = functions.https.onRequest((req, res) => {
  console.log('saveDeviceData', req.body);

  if (_.isEmpty(req.body)) {
    return res.status(400).send({ status: 'Body cannot be empty' });
  }

  let maxRSSI = Math.max(_.map(req.body.metadata.gateways, 'rssi'));
  let maxSNR = Math.max(_.map(req.body.metadata.gateways, 'snr'));

  let deviceId = req.body.dev_id;
  let payload = {
    temperature: req.body.payload_fields.temperature,
    timestamp: req.body.metadata.time,
    longitude: req.body.payload_fields.longitude,
    latitude: req.body.payload_fields.latitude,
    altitude: req.body.payload_fields.altitude,
    deviceId: req.body.dev_id,
    battery: req.body.payload_fields.battery,
    status: req.body.payload_fields.status,
    nsat: req.body.payload_fields.nsat,
    rssi: maxRSSI,
    snr: maxSNR,
  };

  let lastFeaturePoint;
  let featurePoint;

  payload = JSON.parse(JSON.stringify(payload));

  return db.ref(config.paths.participants).child(deviceId)
    .once('value', data => lastFeaturePoint = data.val())
  .then(() => featurePoint = createFeaturePoint(payload, lastFeaturePoint))
  .then(() => updateFirebase(featurePoint))
  .then(() => addToBigquery(featurePoint.properties))
  .then(() => res.status(200).send({ status: 'OK' }));
});


exports.updateLeaderboard = functions.https.onRequest((req, res) => {
  const filePath = req.body.filePath;
  let participants;

  if (!filePath) {
    return res.status(400).send({ status: 'filePath cannot be empty' });
  }

  return db.ref(config.paths.participants)
    .once('value', data => participants = data.val())
  .then(() => raceTrack || loadRaceTrack(filePath))
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
