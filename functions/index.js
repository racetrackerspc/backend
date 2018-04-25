const functions = require('firebase-functions');
const bigquery = require('@google-cloud/bigquery')();
const admin = require('firebase-admin');
const _ = require('lodash');

admin.initializeApp();

const db = admin.database()
const endpoint = '/participants_test'


function updateFirebase(data) {
  if (data.properties.longitude) {
    return db.ref(endpoint)
      .child(data.properties.deviceId)
      .set(data);
  } else {
    return {}
  }
}

function addToBigquery(data) {
  const dataset = bigquery.dataset(functions.config().bigquery.datasetname);
  const table = dataset.table(functions.config().bigquery.tablename);

  return table.insert(data);
}

exports.saveDeviceData = functions.https.onRequest((req, res) => {
  const rawData = req.body;

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

  db.ref(endpoint).child(deviceId).once("value", function(data) {
    let longitude = payload.longitude;
    let latitude = payload.latitude;
    let lastData = data.val()

    if (status === 205 && lastData) {
      longitude = lastData.properties.longitude;
      latitude = lastData.properties.latitude;
    }

    let geojson = {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [longitude, latitude]
      },
      properties: payload
    };

    return Promise.all([
      updateFirebase(geojson),
      addToBigquery(payload)
    ]).then(() => {
      return res.status(200).send({ status: 'OK' });
    });
  });
});
