/**
 * Uber rider deep links (universal link → opens app when installed).
 * @see https://developer.uber.com/docs/riders/ride-requests/tutorials/deep-links/introduction
 */
export type UberRideLinkOptions = {
  /** Full address or place string for destination */
  dropoffFormattedAddress?: string;
  /** Short label, e.g. venue name */
  dropoffNickname?: string;
  /** Explicit pickup address; omit to use current location */
  pickupFormattedAddress?: string;
  /** Default true: use device location for pickup when no pickup address */
  pickupMyLocation?: boolean;
};

export function buildUberRideDeepLink(options: UberRideLinkOptions = {}): string {
  const clientId = process.env.UBER_CLIENT_ID?.trim();
  const params = new URLSearchParams();
  params.set('action', 'setPickup');
  if (clientId) params.set('client_id', clientId);

  const pickupAddr = options.pickupFormattedAddress?.trim();
  const useMyLocation = options.pickupMyLocation !== false && !pickupAddr;
  if (useMyLocation) {
    params.set('pickup', 'my_location');
  } else if (pickupAddr) {
    params.append('pickup[formatted_address]', pickupAddr);
  } else {
    params.set('pickup', 'my_location');
  }

  const dropAddr = options.dropoffFormattedAddress?.trim();
  const dropNick = options.dropoffNickname?.trim();
  if (dropAddr) params.append('dropoff[formatted_address]', dropAddr);
  if (dropNick) params.append('dropoff[nickname]', dropNick);

  return `https://m.uber.com/ul/?${params.toString()}`;
}
