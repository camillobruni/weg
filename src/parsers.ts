// Copyright (c) 2026, Camillo Bruni.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

'use strict';

import FitParser from 'fit-file-parser';

export interface TrackPoint {
  lat: number;
  lon: number;
  ele: number | null;
  time: number | null;
  hr: number | null;
  cad: number | null;
  power: number | null;
  speed: number | null;
  temp: number | null;
  gearFront: number | null;
  gearRear: number | null;
  gearFrontTooth: number | null;
  gearRearTooth: number | null;
  battery: number | null;
  gears: number | null;
  dist?: number;
  gradient?: number | null;
}

export interface TrackStats {
  totalDist: number;
  elevGain: number;
  elevLoss: number;
  duration: number | null;
  avgSpeed: number | null;
  maxSpeed: number;
  avgPower: number | null;
  maxPower: number;
  avgHR: number | null;
  maxHR: number;
  avgCadence: number | null;
  sensors: string[];
  startTime?: number | null;
  powerCurve?: Record<number, { power: number; idx: number }> | null;
  hrCurve?: Record<number, { hr: number; idx: number }> | null;
  hrZones?: number[] | null; // Time in seconds for each zone
  powerZones?: number[] | null; // Time in seconds for each zone
  shifts?: number | null; // Total number of shifts detected
  avgBattery?: number | null;
}

export interface DeviceInfo {
  name?: string;
  manufacturer?: string;
  product?: string;
  serial?: string;
  version?: string;
  hardwareVersion?: string;
  type?: string;
  batteryStatus?: string;
  batteryVoltage?: number;
  batteryLevel?: number;
  sourceType?: string;
}

export interface TrackData {
  id: string;
  name: string;
  fileName?: string;
  fileSize?: number;
  device: string | null;
  devices?: DeviceInfo[];
  sport?: string | null;
  subSport?: string | null;
  format: 'gpx' | 'fit' | 'tcx' | 'kml';
  points: TrackPoint[];
  stats: TrackStats;
  color: string;
  addedAt: number;
  visible: boolean;
  tags?: string[];
  _filtered?: boolean;
}

export const Parsers = (() => {
  // ── Haversine distance (metres) ──────────────────────────────
  function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const φ1 = (lat1 * Math.PI) / 180,
      φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // ── Enrich track with distance & metadata ──────────────────
  function enrichPoints(pts: TrackPoint[]): TrackPoint[] {
    let totalDist = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i > 0) {
        const prev = pts[i - 1];
        const d = haversine(prev.lat, prev.lon, p.lat, p.lon);
        totalDist += d;

        // Calculate speed if missing (m/s)
        if (p.speed == null && p.time != null && prev.time != null) {
          const dt = (p.time - prev.time) / 1000;
          if (dt > 0 && dt < 10) { // Skip big gaps
            p.speed = d / dt;
          }
        }

        // Calculate gradient if missing (%)
        if (p.gradient === undefined && p.ele != null && prev.ele != null) {
          const de = p.ele - prev.ele;
          if (d > 0.5) { // Only calculate for non-tiny movements to reduce jitter
            p.gradient = (de / d) * 100;
          } else {
            p.gradient = prev.gradient || 0;
          }
        }
      }
      p.dist = totalDist;
    }

    // Optional: basic smoothing for gradient
    for (let i = 1; i < pts.length - 1; i++) {
      if (pts[i].gradient != null && pts[i - 1].gradient != null && pts[i + 1].gradient != null) {
        pts[i].gradient = (pts[i - 1].gradient! + pts[i].gradient! + pts[i + 1].gradient!) / 3;
      }
    }

    return pts;
  }

  // ── Compute stats ─────────────────────────────────────────────
  let hrZoneThresholds = [120, 140, 160, 180];
  let ftp = 200;

  function computeStats(pts: TrackPoint[]): TrackStats {
    const stats: TrackStats = {
      totalDist: 0,
      elevGain: 0,
      elevLoss: 0,
      duration: null,
      avgSpeed: null,
      maxSpeed: 0,
      avgPower: null,
      maxPower: 0,
      avgHR: null,
      maxHR: 0,
      avgCadence: null,
      sensors: [],
      startTime: pts.length ? pts[0].time : null,
    };

    if (!pts.length) return stats;

    let powerSum = 0,
      powerN = 0;
    let hrSum = 0,
      hrN = 0;
    let cadSum = 0,
      cadN = 0;
    let speedSum = 0,
      speedN = 0;
    let batterySum = 0,
      batteryN = 0;
    let hasTemp = false;
    let shifts = 0;
    let hasGears = false;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i > 0) {
        const prev = pts[i - 1];
        if (p.ele != null && prev.ele != null) {
          const diff = p.ele - prev.ele;
          if (diff > 0) stats.elevGain += diff;
          else stats.elevLoss -= diff;
        }
        if (
          (p.gearFront != null && p.gearFront !== prev.gearFront) ||
          (p.gearRear != null && p.gearRear !== prev.gearRear)
        ) {
          shifts++;
        }
      }
      if (p.power != null) {
        powerSum += p.power;
        powerN++;
        if (p.power > stats.maxPower) stats.maxPower = p.power;
      }
      if (p.hr != null) {
        hrSum += p.hr;
        hrN++;
        if (p.hr > stats.maxHR) stats.maxHR = p.hr;
      }
      if (p.cad != null) {
        cadSum += p.cad;
        cadN++;
      }
      if (p.speed != null) {
        speedSum += p.speed;
        speedN++;
        if (p.speed > stats.maxSpeed) stats.maxSpeed = p.speed;
      }
      if (p.battery != null) {
        batterySum += p.battery;
        batteryN++;
      }
      if (p.temp != null) hasTemp = true;
      if (p.gearFront != null || p.gearRear != null) hasGears = true;
    }

    stats.totalDist = pts[pts.length - 1].dist || 0;
    stats.avgPower = powerN ? Math.round(powerSum / powerN) : null;
    stats.avgHR = hrN ? Math.round(hrSum / hrN) : null;
    stats.avgCadence = cadN ? Math.round(cadSum / cadN) : null;
    stats.avgSpeed = speedN ? speedSum / speedN : null;
    stats.avgBattery = batteryN ? Math.round(batterySum / batteryN) : null;
    stats.shifts = hasGears ? shifts : null;

    const t0 = pts[0].time;
    const t1 = pts[pts.length - 1].time;
    if (t0 != null && t1 != null) {
      stats.duration = t1 - t0;
    }

    if (hrN) {
      stats.sensors.push('Heart Rate');
      stats.hrZones = calculateHRZones(pts);
      stats.hrCurve = calculateHRCurve(pts);
    }
    if (cadN) stats.sensors.push('Cadence');
    if (powerN) {
      stats.sensors.push('Power');
      stats.powerCurve = calculatePowerCurve(pts);
      stats.powerZones = calculatePowerZones(pts);
    }
    if (hasTemp) stats.sensors.push('Temperature');
    if (hasGears) stats.sensors.push('Shifting');
    if (batteryN) stats.sensors.push('Battery');

    return stats;
  }

  const STANDARD_CURVE_DURATIONS = [
    1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 10800, 14400, 18000, 21600,
  ];

  function calculateSlidingMax(data: number[], durations: number[]) {
    const curve: Record<number, { val: number; idx: number }> = {};

    durations.forEach((d) => {
      if (d > data.length) return;
      let maxAvg = 0;
      let bestIdx = 0;
      let currentSum = 0;

      for (let i = 0; i < data.length; i++) {
        currentSum += data[i];
        if (i >= d) {
          currentSum -= data[i - d];
        }
        if (i >= d - 1) {
          const avg = currentSum / d;
          if (avg > maxAvg) {
            maxAvg = avg;
            bestIdx = i - d + 1;
          }
        }
      }
      curve[d] = { val: Math.round(maxAvg), idx: bestIdx };
    });

    return Object.keys(curve).length > 0 ? curve : null;
  }

  function calculatePowerCurve(pts: TrackPoint[]) {
    const powerData = pts.map((p) => p.power || 0);
    if (powerData.every((p) => p === 0)) return null;
    const curve = calculateSlidingMax(powerData, STANDARD_CURVE_DURATIONS);
    if (!curve) return null;

    const result: Record<number, { power: number; idx: number }> = {};
    for (const d in curve) {
      result[d] = { power: curve[d].val, idx: curve[d].idx };
    }
    return result;
  }

  function calculateHRCurve(pts: TrackPoint[]) {
    const hrData = pts.map((p) => p.hr || 0);
    if (hrData.every((p) => p === 0)) return null;
    const curve = calculateSlidingMax(hrData, STANDARD_CURVE_DURATIONS);
    if (!curve) return null;

    const result: Record<number, { hr: number; idx: number }> = {};
    for (const d in curve) {
      result[d] = { hr: curve[d].val, idx: curve[d].idx };
    }
    return result;
  }

  function calculatePowerZones(pts: TrackPoint[]) {
    const zones = [0, 0, 0, 0, 0, 0, 0];
    const thresholds = [0.55, 0.75, 0.9, 1.05, 1.2, 1.5].map((t) => t * ftp);

    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const prev = pts[i - 1];
      if (p.power == null || p.time == null || prev.time == null) continue;

      const dt = (p.time - prev.time) / 1000;
      if (dt <= 0 || dt > 10) continue;

      const pw = p.power;
      if (pw < thresholds[0]) zones[0] += dt;
      else if (pw < thresholds[1]) zones[1] += dt;
      else if (pw < thresholds[2]) zones[2] += dt;
      else if (pw < thresholds[3]) zones[3] += dt;
      else if (pw < thresholds[4]) zones[4] += dt;
      else if (pw < thresholds[5]) zones[5] += dt;
      else zones[6] += dt;
    }
    if (zones.every((z) => z === 0)) return null;
    return zones;
  }

  function setFTP(val: number) {
    ftp = val;
  }

  function getFTP() {
    return ftp;
  }

  function calculateHRZones(pts: TrackPoint[]) {
    const zones = [0, 0, 0, 0, 0];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const prev = pts[i - 1];
      if (p.hr == null || p.time == null || prev.time == null) continue;

      const dt = (p.time - prev.time) / 1000;
      if (dt <= 0 || dt > 10) continue; // Skip gaps

      const hr = p.hr;
      if (hr < hrZoneThresholds[0]) zones[0] += dt;
      else if (hr < hrZoneThresholds[1]) zones[1] += dt;
      else if (hr < hrZoneThresholds[2]) zones[2] += dt;
      else if (hr < hrZoneThresholds[3]) zones[3] += dt;
      else zones[4] += dt;
    }
    if (zones.every((z) => z === 0)) return null;
    return zones;
  }

  function setHRZones(thresholds: number[]) {
    hrZoneThresholds = thresholds;
  }

  function getHRZones() {
    return [...hrZoneThresholds];
  }

  // ── GPX parser ────────────────────────────────────────────────
  function parseGPX(buf: ArrayBuffer): any {
    const text: string = new TextDecoder().decode(buf);
    const doc: Document = new DOMParser().parseFromString(text, 'application/xml');

    const ns: Record<string, string> = {
      gpx: 'http://www.topografix.com/GPX/1/1',
      tpx: 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1',
      gpxx: 'http://www.garmin.com/xmlschemas/GpxExtensions/v3',
    };

    // Track name
    let name = 'Unnamed Track';
    const nameEl = doc.querySelector('trk > name, gpx > metadata > name');
    if (nameEl) name = nameEl.textContent?.trim() || name;

    // Device / Creator
    const device = doc.documentElement.getAttribute('creator') || null;

    // Collect all trkpt elements
    const trkpts = Array.from(doc.querySelectorAll('trkpt'));
    if (!trkpts.length) throw new Error('No track points found in GPX');

    const points: TrackPoint[] = trkpts.map((el) => {
      const lat = parseFloat(el.getAttribute('lat') || '0');
      const lon = parseFloat(el.getAttribute('lon') || '0');
      const eleEl = el.querySelector('ele');
      const timeEl = el.querySelector('time');

      // Heart rate: <hr> or <gpxtpx:hr>
      let hr: number | null = null;
      const hrEl = el.querySelector('hr, HeartRateBpm');
      if (hrEl) hr = parseInt(hrEl.textContent || '') || null;
      if (!hr) {
        const hrNs = el.getElementsByTagNameNS(ns.tpx, 'hr')[0];
        if (hrNs) hr = parseInt(hrNs.textContent || '') || null;
      }

      // Cadence: <cad> or <gpxtpx:cad>
      let cad: number | null = null;
      const cadEl = el.querySelector('cad, Cadence');
      if (cadEl) cad = parseInt(cadEl.textContent || '') || null;
      if (!cad) {
        const cadNs = el.getElementsByTagNameNS(ns.tpx, 'cad')[0];
        if (cadNs) cad = parseInt(cadNs.textContent || '') || null;
      }

      // Power: <power> or <PowerInWatts> inside extensions
      let power: number | null = null;
      const pwEl = el.querySelector('power, PowerInWatts');
      if (pwEl) power = parseFloat(pwEl.textContent || '') || null;
      if (!power) {
        const pwNs = el.getElementsByTagNameNS(ns.tpx, 'PowerInWatts')[0];
        if (pwNs) power = parseFloat(pwNs.textContent || '') || null;
      }

      // Temp: <atemp>
      let temp: number | null = null;
      const tempEl = el.querySelector('atemp, temp');
      if (tempEl) temp = parseFloat(tempEl.textContent || '') || null;
      if (!temp) {
        const tempNs = el.getElementsByTagNameNS(ns.tpx, 'atemp')[0];
        if (tempNs) temp = parseFloat(tempNs.textContent || '') || null;
      }

      return {
        lat,
        lon,
        ele: eleEl ? parseFloat(eleEl.textContent || '0') : null,
        time: timeEl ? new Date(timeEl.textContent || '').getTime() : null,
        hr,
        cad,
        power,
        speed: null, // GPX usually doesn't have speed per point
        temp,
        gearFront: null,
        gearRear: null,
        gearFrontTooth: null,
        gearRearTooth: null,
        battery: null,
        gears: null,
      };
    });

    const pts = enrichPoints(points);
    const stats = computeStats(pts);
    return { name, device, format: 'gpx', points: pts, stats };
  }

  // ── TCX parser ────────────────────────────────────────────────
  function parseTCX(buf: ArrayBuffer): any {
    const text: string = new TextDecoder().decode(buf);
    const doc: Document = new DOMParser().parseFromString(text, 'application/xml');

    const ns = {
      tcx: 'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2',
      tpx: 'http://www.garmin.com/xmlschemas/ActivityExtension/v2',
    };

    let name = 'Unnamed TCX';
    const nameEl = doc.querySelector('Id');
    if (nameEl) name = nameEl.textContent?.trim() || name;

    const deviceEl = doc.querySelector('Creator Name');
    const device = deviceEl ? deviceEl.textContent?.trim() || null : null;

    const trackpts = Array.from(doc.querySelectorAll('Trackpoint'));
    const points = trackpts
      .map((el) => {
        const latEl = el.querySelector('LatitudeDegrees');
        const lonEl = el.querySelector('LongitudeDegrees');
        if (!latEl || !lonEl) return null;

        const eleEl = el.querySelector('AltitudeMeters');
        const timeEl = el.querySelector('Time');
        const hrEl = el.querySelector('HeartRateBpm Value');
        const cadEl = el.querySelector('Cadence');

        // Power and Speed are often in extensions
        let power: number | null = null;
        let speed: number | null = null;
        let temp: number | null = null;

        const ext = el.querySelector('Extensions');
        if (ext) {
          const pEl = ext.querySelector('Watts, Power');
          if (pEl) power = parseFloat(pEl.textContent || '');
          const sEl = ext.querySelector('Speed');
          if (sEl) speed = parseFloat(sEl.textContent || '');
          const tEl = ext.querySelector('AvgTemperature, Temp');
          if (tEl) temp = parseFloat(tEl.textContent || '');
        }

        return {
          lat: parseFloat(latEl.textContent || '0'),
          lon: parseFloat(lonEl.textContent || '0'),
          ele: eleEl ? parseFloat(eleEl.textContent || '0') : null,
          time: timeEl ? new Date(timeEl.textContent || '').getTime() : null,
          hr: hrEl ? parseInt(hrEl.textContent || '') : null,
          cad: cadEl ? parseInt(cadEl.textContent || '') : null,
          power,
          speed,
          temp,
          gearFront: null,
          gearRear: null,
          battery: null,
        } as TrackPoint;
      })
      .filter((p): p is TrackPoint => p !== null);

    const pts = enrichPoints(points);
    const stats = computeStats(pts);
    return { name, device, format: 'tcx', points: pts, stats };
  }

  // ── FIT parser ────────────────────────────────────────────────
  function parseFIT(buf: ArrayBuffer): Promise<any> {
    return new Promise((resolve, reject) => {
      const fitParser = new FitParser({
        force: true,
        speedUnit: 'km/h',
        lengthUnit: 'm',
        temperatureUnit: 'celsius',
        elapsedRecordField: true,
      });

      fitParser.parse(buf, (error: any, data: any) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const name = data.sessions?.[0]?.start_time
            ? `Fit Activity ${new Date(data.sessions[0].start_time).toISOString().split('T')[0]}`
            : 'Unnamed Fit';
          
          // Better device detection
          let device: string | null = null;
          const devices: DeviceInfo[] = [];
          let sport: string | null = null;
          let subSport: string | null = null;

          if (data.sports?.[0]) {
            sport = data.sports[0].sport;
            subSport = data.sports[0].sub_sport;
          } else if (data.sessions?.[0]) {
            sport = data.sessions[0].sport;
            subSport = data.sessions[0].sub_sport;
          }

          const getDeviceName = (d: any) => d.product_name || d.garmin_product || d.product || d.device_type || d.manufacturer || null;

          if (data.file_ids?.[0]) {
            const fid = data.file_ids[0];
            device = getDeviceName(fid);
            devices.push({
              name: fid.product_name || fid.garmin_product || fid.product,
              manufacturer: fid.manufacturer,
              serial: fid.serial_number ? String(fid.serial_number) : undefined,
              version: fid.software_version ? String(fid.software_version) : undefined,
              type: 'main',
            });
          }

          if (data.device_infos) {
            data.device_infos.forEach((d: any) => {
              const isMain = d.device_index === 'creator' || d.device_index === 0;
              
              if (isMain) {
                const name = getDeviceName(d);
                // Prefer a name with product_name or garmin_product over generic ones
                if (d.product_name || d.garmin_product || !device) {
                  device = name;
                }
                
                // Update existing main device if needed
                if (devices.length > 0 && devices[0].type === 'main') {
                  if (d.product_name || d.garmin_product || !devices[0].name) {
                    devices[0].name = d.product_name || d.garmin_product || d.product;
                  }
                  if (!devices[0].manufacturer) devices[0].manufacturer = d.manufacturer;
                  if (!devices[0].serial && d.serial_number) devices[0].serial = String(d.serial_number);
                  if (!devices[0].version && d.software_version) devices[0].version = String(d.software_version);
                  if (!devices[0].hardwareVersion && d.hardware_version) devices[0].hardwareVersion = String(d.hardware_version);
                }
                return;
              }

              devices.push({
                name: d.product_name || d.garmin_product || d.product || d.device_type || 'Sensor',
                manufacturer: d.manufacturer,
                serial: d.serial_number ? String(d.serial_number) : undefined,
                version: d.software_version ? String(d.software_version) : undefined,
                hardwareVersion: d.hardware_version ? String(d.hardware_version) : undefined,
                type: d.device_type || 'sensor',
                batteryStatus: d.battery_status,
                batteryVoltage: d.battery_voltage,
                batteryLevel: d.battery_level,
                sourceType: d.source_type != null ? String(d.source_type) : undefined,
              });
            });
          }

          if (data.sensor_settings) {
            data.sensor_settings.forEach((s: any) => {
              const name = s.name || s.product || s.sensor_type;
              if (!name) return;

              // Check if we already have this device (by ANT ID or name)
              const antId = s.ant_id ? String(s.ant_id) : undefined;
              const existing = devices.find(d => 
                (antId && d.serial === antId) || 
                (d.name === name && d.manufacturer === s.manufacturer)
              );

              if (existing) {
                if (!existing.name) existing.name = name;
                if (!existing.manufacturer) existing.manufacturer = s.manufacturer;
                if (!existing.type) existing.type = s.sensor_type;
                if (!existing.sourceType) existing.sourceType = s.connection_type != null ? String(s.connection_type) : undefined;
              } else {
                devices.push({
                  name: name,
                  manufacturer: s.manufacturer,
                  serial: antId,
                  type: s.sensor_type || 'sensor',
                  sourceType: s.connection_type != null ? String(s.connection_type) : undefined,
                });
              }
            });
          }

          // Collect standalone device status reports (often contains head unit battery)
          // We'll store them in a sorted array for easier lookups
          const statusReports: { time: number, level: number | null }[] = [];
          if (data.device_statuses) {
            data.device_statuses.forEach((s: any) => {
              if (s.timestamp && s.battery_level != null) {
                statusReports.push({
                  time: new Date(s.timestamp).getTime(),
                  level: s.battery_level
                });
              }
            });
            statusReports.sort((a, b) => a.time - b.time);
          }

          // Collect gear events
          const gearEvents: { time: number, front: number | null, rear: number | null, frontTooth: number | null, rearTooth: number | null }[] = [];
          if (data.events) {
            data.events.forEach((e: any) => {
              let front = e.front_gear_num ?? e.front_gear ?? null;
              let rear = e.rear_gear_num ?? e.rear_gear ?? null;
              let frontTooth = e.front_gear_num_tooth ?? null;
              let rearTooth = e.rear_gear_num_tooth ?? null;

              if (e.event === 'rear_gear_change' || e.event === 'front_gear_change') {
                const d = e.data;
                if (d != null) {
                  const ft = (d >> 24) & 0xFF;
                  const fg = (d >> 16) & 0xFF;
                  const rt = (d >> 8) & 0xFF;
                  const rg = d & 0xFF;
                  
                  if (fg !== 0) front = fg;
                  if (ft !== 0) frontTooth = ft;
                  if (rg !== 0) rear = rg;
                  if (rt !== 0) rearTooth = rt;
                }
              }

              if (e.timestamp && (front != null || rear != null || frontTooth != null || rearTooth != null)) {
                gearEvents.push({
                  time: new Date(e.timestamp).getTime(),
                  front,
                  rear,
                  frontTooth,
                  rearTooth
                });
              }
            });
            gearEvents.sort((a, b) => a.time - b.time);
          }

          const records = data.records || [];
          let lastBattery: number | null = null;
          let statusIdx = 0;
          let lastFrontGear: number | null = null;
          let lastRearGear: number | null = null;
          let lastFrontTooth: number | null = null;
          let lastRearTooth: number | null = null;
          let gearIdx = 0;

          const points = records.map((r: any) => {
            const lat = r.position_lat;
            const lon = r.position_long;
            if (lat == null || lon == null) return null;

            const time = r.timestamp ? new Date(r.timestamp).getTime() : null;
            const speed = r.speed != null ? r.speed / 3.6 : null; // km/h → m/s
            
            let battery = r.battery_level ?? null;
            
            // If not in record, check our status reports
            if (battery == null && time) {
              // Catch up statusIdx to current time
              while (statusIdx < statusReports.length && statusReports[statusIdx].time <= time) {
                lastBattery = statusReports[statusIdx].level;
                statusIdx++;
              }
              battery = lastBattery;
            } else if (battery != null) {
              lastBattery = battery;
            }

            // Update gear state from events
            if (time) {
              while (gearIdx < gearEvents.length && gearEvents[gearIdx].time <= time) {
                const e = gearEvents[gearIdx];
                if (e.front != null) lastFrontGear = e.front;
                if (e.rear != null) lastRearGear = e.rear;
                if (e.frontTooth != null) lastFrontTooth = e.frontTooth;
                if (e.rearTooth != null) lastRearTooth = e.rearTooth;
                gearIdx++;
              }
            }

            const gearFront = r.front_gear_num ?? r.front_gear ?? lastFrontGear;
            const gearRear = r.rear_gear_num ?? r.rear_gear ?? lastRearGear;
            const gearFrontTooth = r.front_gear_num_tooth ?? lastFrontTooth;
            const gearRearTooth = r.rear_gear_num_tooth ?? lastRearTooth;

            if (r.front_gear_num != null || r.front_gear != null) lastFrontGear = gearFront;
            if (r.rear_gear_num != null || r.rear_gear != null) lastRearGear = gearRear;
            if (r.front_gear_num_tooth != null) lastFrontTooth = gearFrontTooth;
            if (r.rear_gear_num_tooth != null) lastRearTooth = gearRearTooth;

            const gears = (gearFrontTooth != null && gearRearTooth != null && gearRearTooth !== 0)
              ? gearFrontTooth / gearRearTooth
              : null;

            return {
              lat,
              lon,
              ele: r.altitude ?? r.enhanced_altitude ?? null,
              time,
              hr: r.heart_rate ?? null,
              cad: r.cadence ?? null,
              power: r.power ?? null,
              speed,
              temp: r.temperature ?? null,
              gearFront,
              gearRear,
              gearFrontTooth,
              gearRearTooth,
              battery,
              gears,
            } as TrackPoint;
          });
          const validPoints = points.filter((p: any): p is TrackPoint => p !== null);

          if (!validPoints.length) {
            reject(new Error('FIT file has no GPS points'));
            return;
          }

          const pts = enrichPoints(validPoints);
          const stats = computeStats(pts);
          resolve({ name, device, devices, format: 'fit', points: pts, stats, sport, subSport });
        } catch (ex) {
          reject(ex);
        }
      });
    });
  }

  // ── KML parser ────────────────────────────────────────────────
  function parseKML(buf: ArrayBuffer): any {
    const text = new TextDecoder().decode(buf);
    const doc = new DOMParser().parseFromString(text, 'application/xml');

    let name = 'Unnamed Track';
    const nameEl = doc.querySelector('Document > name, Placemark > name');
    if (nameEl) name = nameEl.textContent?.trim() || name;

    // Track: look for gx:Track or LineString
    const coordEls = doc.querySelectorAll('coordinates');
    if (!coordEls.length) throw new Error('No coordinates found in KML');

    const points: TrackPoint[] = [];
    coordEls.forEach((el) => {
      const lines = el.textContent?.trim().split(/\s+/) || [];
      lines.forEach((line) => {
        const parts = line.split(',');
        if (parts.length < 2) return;
        const lon = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        const ele = parts.length > 2 ? parseFloat(parts[2]) : null;
        if (isNaN(lat) || isNaN(lon)) return;
        points.push({
          lat,
          lon,
          ele: ele != null && isNaN(ele) ? null : ele,
          time: null,
          hr: null,
          cad: null,
          power: null,
          speed: null,
          temp: null,
          gearFront: null,
          gearRear: null,
          gearFrontTooth: null,
          gearRearTooth: null,
          battery: null,
          gears: null,
        });
      });
    });

    if (!points.length) throw new Error('No valid coordinates in KML');
    const pts = enrichPoints(points);
    const stats = computeStats(pts);
    return { name, format: 'kml', points: pts, stats };
  }

  // ── Public: dispatch by extension ────────────────────────────
  async function parseFile(file: File): Promise<any> {
    const ext = file.name.split('.').pop()?.toLowerCase();
    const buf = await file.arrayBuffer();
    let result: any;
    switch (ext) {
      case 'gpx':
        result = parseGPX(buf);
        break;
      case 'tcx':
        result = parseTCX(buf);
        break;
      case 'fit':
        result = await parseFIT(buf);
        break;
      case 'kml':
        result = parseKML(buf);
        break;
      default:
        throw new Error(`Unsupported format: .${ext}`);
    }
    
    if (result) {
      result.fileName = file.name;
      result.fileSize = file.size;
    }
    return result;
  }

  return {
    parseFile,
    computeStats,
    enrichPoints,
    setHRZones,
    getHRZones,
    setFTP,
    getFTP,
  };
})();
