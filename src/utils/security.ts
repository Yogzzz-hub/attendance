/**
 * Security utilities for IP whitelisting and geofencing validation
 */

/**
 * Detect if running in local development environment (localhost, 127.0.0.1, or Vite DEV mode)
 */
export const isLocalEnvironment = (): boolean => {
  if (typeof window === 'undefined') return false;
  const hostname = window.location.hostname;
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.local') ||
    Boolean(import.meta.env?.DEV)
  );
};

/**
 * Calculate distance between two coordinates using Haversine formula
 * @returns Distance in meters
 */
export const calculateDistance = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number => {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

/**
 * Fetch client public IP address
 */
export const getClientIP = async (): Promise<string | null> => {
  try {
    const response = await fetch('https://api.ipify.org?format=json', {
      method: 'GET',
      cache: 'no-cache'
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    return data.ip || null;
  } catch (error) {
    console.error('Failed to fetch client IP:', error);
    return null;
  }
};

/**
 * Check if an IP matches office subnet or local development
 */
export const isOfficeSubnetOrLocal = (ip: string, allowedIP: string): boolean => {
  if (isLocalEnvironment()) return true;
  if (!ip) return false;

  // Local loopbacks
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;

  // If allowed IP is configured as local/loopback
  if (allowedIP === '127.0.0.1' || allowedIP === 'localhost') return true;

  // Support wildcard matching for subnets (e.g., 192.168.1.* or 10.*)
  if (allowedIP.includes('*')) {
    const allowedPattern = allowedIP.replace(/\./g, '\\.').replace(/\*/g, '.*');
    const regex = new RegExp(`^${allowedPattern}$`);
    return regex.test(ip);
  }

  return ip === allowedIP;
};

/**
 * Verify client IP address against allowed office IP
 */
export const verifyIPAddress = async (allowedIP: string): Promise<{ valid: boolean; ip: string | null; isLocalOrSubnet?: boolean }> => {
  try {
    if (isLocalEnvironment()) {
      return { valid: true, ip: '127.0.0.1', isLocalOrSubnet: true };
    }

    const clientIP = await getClientIP();
    if (!clientIP) {
      if (isLocalEnvironment() || allowedIP === '127.0.0.1') {
        return { valid: true, ip: '127.0.0.1', isLocalOrSubnet: true };
      }
      return { valid: false, ip: null };
    }

    const matches = isOfficeSubnetOrLocal(clientIP, allowedIP);
    return { valid: matches, ip: clientIP, isLocalOrSubnet: matches };
  } catch (error) {
    console.error('IP verification failed:', error);
    if (isLocalEnvironment()) {
      return { valid: true, ip: '127.0.0.1', isLocalOrSubnet: true };
    }
    return { valid: false, ip: null };
  }
};

/**
 * Validate geofence location with optional localhost / dev bypass or network override
 */
export const verifyGeofence = (
  currentLat: number,
  currentLon: number,
  officeLat: number,
  officeLon: number,
  allowedRadiusMeters: number,
  options?: { allowLocalhostBypass?: boolean; officeNetworkVerified?: boolean }
): { valid: boolean; distance: number; isDevBypass?: boolean; isNetworkVerified?: boolean } => {
  const distance = calculateDistance(currentLat, currentLon, officeLat, officeLon);
  const allowLocal = options?.allowLocalhostBypass ?? true;
  const isDev = allowLocal && isLocalEnvironment();
  const isNetVerified = Boolean(options?.officeNetworkVerified);

  return {
    valid: isDev || isNetVerified || distance <= allowedRadiusMeters,
    distance: Math.round(distance),
    isDevBypass: isDev,
    isNetworkVerified: isNetVerified
  };
};
