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
}

export interface TrackData {
  id: string;
  name: string;
  device: string | null;
  format: 'gpx' | 'fit' | 'tcx' | 'kml';
  points: TrackPoint[];
  stats: TrackStats;
  color: string;
  addedAt: number;
  visible: boolean;
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
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ── Compute derivative fields (dist, speed, gradient) ────────
  function enrichPoints(pts: TrackPoint[]): TrackPoint[] {
    let cumDist = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i === 0) {
        p.dist = 0;
        if (p.speed == null) p.speed = 0;
      } else {
        const prev = pts[i - 1];
        const d = haversine(prev.lat, prev.lon, p.lat, p.lon);
        cumDist += d;
        p.dist = cumDist;

        // Derive speed from position+time if not given
        if (p.speed == null && p.time != null && prev.time != null) {
          const dt = (p.time - prev.time) / 1000; // seconds
          p.speed = dt > 0 ? d / dt : 0; // m/s
        }
      }

      // Gradient (%)
      if (i > 0) {
        const prev = pts[i - 1];
        const dDist = (p.dist || 0) - (prev.dist || 0);
        if (dDist > 0.1 && p.ele != null && prev.ele != null) {
          p.gradient = ((p.ele - prev.ele) / dDist) * 100;
        } else {
          p.gradient = null;
        }
      } else {
        p.gradient = null;
      }
    }
    return pts;
  }

  // ── Compute stats ─────────────────────────────────────────────
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
    let hasTemp = false;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i > 0) {
        const prev = pts[i - 1];
        if (p.ele != null && prev.ele != null) {
          const diff = p.ele - prev.ele;
          if (diff > 0) stats.elevGain += diff;
          else stats.elevLoss -= diff;
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
      if (p.temp != null) hasTemp = true;
    }

    stats.totalDist = pts[pts.length - 1].dist || 0;
    stats.avgPower = powerN ? Math.round(powerSum / powerN) : null;
    stats.avgHR = hrN ? Math.round(hrSum / hrN) : null;
    stats.avgCadence = cadN ? Math.round(cadSum / cadN) : null;
    stats.avgSpeed = speedN ? speedSum / speedN : null;

    const t0 = pts[0].time;
    const t1 = pts[pts.length - 1].time;
    if (t0 != null && t1 != null) {
      stats.duration = t1 - t0;
    }

    if (hrN) stats.sensors.push('Heart Rate');
    if (cadN) stats.sensors.push('Cadence');
    if (powerN) stats.sensors.push('Power');
    if (hasTemp) stats.sensors.push('Temperature');

    return stats;
  }

  // ── GPX parser ────────────────────────────────────────────────
  function parseGPX(buf: ArrayBuffer): any {
    const text = new TextDecoder().decode(buf);
    const doc = new DOMParser().parseFromString(text, 'application/xml');

    const ns = {
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
      const eleStr = el.querySelector('ele')?.textContent;
      const ele = eleStr ? parseFloat(eleStr) : null;
      const timeStr = el.querySelector('time')?.textContent;
      const time = timeStr ? new Date(timeStr).getTime() : null;

      // Extensions – try multiple schemas
      const hr =
        parseFloat(
          el.querySelector('hr, HeartRateBpm Value, gpxtpx\\:hr, [localName=hr]')?.textContent ||
            el.getElementsByTagNameNS(ns.tpx, 'hr')[0]?.textContent ||
            '',
        ) || null;

      const cad =
        parseFloat(
          el.querySelector('cad, cadence, gpxtpx\\:cad, [localName=cad]')?.textContent ||
            el.getElementsByTagNameNS(ns.tpx, 'cad')[0]?.textContent ||
            '',
        ) || null;

      const temp =
        parseFloat(
          el.querySelector('atemp, temperature, gpxtpx\\:atemp, [localName=atemp]')?.textContent ||
            el.getElementsByTagNameNS(ns.tpx, 'atemp')[0]?.textContent ||
            '',
        ) || null;

      // Power: <power> or <PowerInWatts> inside extensions
      let power: number | null = null;
      const pwEl = el.querySelector('power, PowerInWatts');
      if (pwEl) power = parseFloat(pwEl.textContent || '') || null;
      if (!power) {
        const pwNs = el.getElementsByTagNameNS(ns.tpx, 'PowerInWatts')[0];
        if (pwNs) power = parseFloat(pwNs.textContent || '') || null;
      }

      return {
        lat,
        lon,
        ele: ele != null && isNaN(ele) ? null : ele,
        time,
        hr,
        cad,
        power,
        speed: null,
        temp,
      };
    });

    const pts = enrichPoints(points);
    const stats = computeStats(pts);
    return { name, device, format: 'gpx', points: pts, stats };
  }

  // ── TCX parser ────────────────────────────────────────────────
  function parseTCX(buf: ArrayBuffer): any {
    const text = new TextDecoder().decode(buf);
    const doc = new DOMParser().parseFromString(text, 'application/xml');

    let name = 'Unnamed Track';
    const idEl = doc.querySelector('Activity > Id');
    if (idEl) name = (idEl.textContent?.trim() || '').replace('T', ' ').substring(0, 19);

    const nameEl = doc.querySelector('Activity > Notes, Activity > Name');
    if (nameEl) name = nameEl.textContent?.trim() || name;

    // Device
    const deviceEl = doc.querySelector('Creator > Name');
    const device = deviceEl ? deviceEl.textContent?.trim() || null : null;

    const tpts = Array.from(doc.querySelectorAll('Trackpoint'));
    if (!tpts.length) throw new Error('No trackpoints found in TCX');

    const points: TrackPoint[] = tpts
      .map((el) => {
        const latStr = el.querySelector('LatitudeDegrees')?.textContent;
        const lonStr = el.querySelector('LongitudeDegrees')?.textContent;
        const lat = latStr ? parseFloat(latStr) : NaN;
        const lon = lonStr ? parseFloat(lonStr) : NaN;
        if (isNaN(lat) || isNaN(lon)) return null;

        const eleStr = el.querySelector('AltitudeMeters')?.textContent;
        const ele = eleStr ? parseFloat(eleStr) : null;
        const timeStr = el.querySelector('Time')?.textContent;
        const time = timeStr ? new Date(timeStr).getTime() : null;
        const hr =
          parseFloat(
            el.querySelector('HeartRateBpm Value, HeartRateBpm > Value')?.textContent || '',
          ) || null;
        const cad = parseFloat(el.querySelector('Cadence')?.textContent || '') || null;

        // Extensions (Garmin ActivityExtension v2)
        const speed =
          parseFloat(el.querySelector('Speed, ns3\\:Speed, Extensions Speed')?.textContent || '') ||
          null;
        const power =
          parseFloat(el.querySelector('Watts, ns3\\:Watts, Extensions Watts')?.textContent || '') ||
          null;

        return {
          lat,
          lon,
          ele: ele != null && isNaN(ele) ? null : ele,
          time,
          hr,
          cad,
          power,
          speed,
          temp: null,
        } as TrackPoint;
      })
      .filter((p): p is TrackPoint => p !== null);

    if (!points.length) throw new Error('No valid trackpoints (with lat/lon) in TCX');
    const pts = enrichPoints(points);
    const stats = computeStats(pts);
    return { name, device, format: 'tcx', points: pts, stats };
  }

  // ── FIT parser ────────────────────────────────────────────────
  function parseFIT(buf: ArrayBuffer): Promise<any> {
    return new Promise((resolve, reject) => {
      if (typeof FitParser === 'undefined') {
        reject(new Error('FIT parser not loaded. Check your connection.'));
        return;
      }
      const fit = new FitParser({
        force: true,
        speedUnit: 'km/h',
        lengthUnit: 'm',
        temperatureUnit: 'celsius',
        elapsedRecordField: false,
        mode: 'cascade',
      });
      fit.parse(buf, (err: any, data: any) => {
        if (err) {
          reject(new Error('FIT parse error: ' + err));
          return;
        }
        try {
          let name = 'FIT Activity';
          const sessions = data.activity?.sessions;
          if (!sessions?.length) {
            reject(new Error('No sessions in FIT file'));
            return;
          }

          // Device info
          let device = null;
          const fileId = data.file_id;
          if (fileId) {
            const manufacturer = fileId.manufacturer;
            const product = fileId.product;
            if (manufacturer && product) device = `${manufacturer} ${product}`;
            else if (manufacturer) device = manufacturer;
          }

          // Collect all records across laps
          const allRecords: any[] = [];
          for (const session of sessions) {
            for (const lap of session.laps || []) {
              for (const rec of lap.records || []) {
                allRecords.push(rec);
              }
            }
          }
          if (!allRecords.length) {
            reject(new Error('No records in FIT file'));
            return;
          }

          // Try to extract a sport/name
          const sport = sessions[0]?.sport;
          if (sport) name = sport.charAt(0).toUpperCase() + sport.slice(1) + ' Activity';
          // Use start time as part of name
          const st = sessions[0]?.start_time;
          if (st) {
            const d = st instanceof Date ? st : new Date(st);
            name += ' ' + d.toISOString().slice(0, 10);
          }

          const points: (TrackPoint | null)[] = allRecords.map((r) => {
            const lat = r.position_lat;
            const lon = r.position_long;
            if (lat == null || lon == null) return null;
            const time = r.timestamp
              ? r.timestamp instanceof Date
                ? r.timestamp.getTime()
                : new Date(r.timestamp).getTime()
              : null;
            const speed = r.speed != null ? r.speed / 3.6 : null; // km/h → m/s
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
            };
          });
          const validPoints = points.filter((p): p is TrackPoint => p !== null);

          if (!validPoints.length) {
            reject(new Error('FIT file has no GPS points'));
            return;
          }

          const pts = enrichPoints(validPoints);
          const stats = computeStats(pts);
          resolve({ name, device, format: 'fit', points: pts, stats });
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
    switch (ext) {
      case 'gpx':
        return parseGPX(buf);
      case 'tcx':
        return parseTCX(buf);
      case 'fit':
        return parseFIT(buf);
      case 'kml':
        return parseKML(buf);
      default:
        throw new Error(`Unsupported format: .${ext}`);
    }
  }

  return { parseFile };
})();
