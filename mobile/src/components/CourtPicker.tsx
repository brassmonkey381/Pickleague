// Thin backward-compat shim around the kit's generic VenuePicker. Retargeted
// off the kit's deprecated CourtPicker wrapper (removed in kit 1.0.0) — this
// shim now supplies the original court-flavored default copy locally so every
// `../components/CourtPicker` consumer sees zero change. Platform resolution
// (.tsx / .web.tsx) still happens inside the package's VenuePicker pair.
//
// It also wires our own venue catalog (public.venues) in as `localSearch` and
// turns the external provider OFF (externalSearch="none") — the picker now
// searches ONLY our catalog (plus GPS / pasted coordinates), no Google Places /
// Nominatim and no EXPO_PUBLIC_GOOGLE_PLACES_KEY. Consumers can override any prop
// (e.g. pass externalSearch="google" to re-enable the external fallback).
import React from 'react';
import { VenuePicker, type VenuePickerProps, type VenueResult } from '@just-messin-around/expo-foundation/ui';
import { venueLocalSearch } from '../lib/venues';

/** Court-flavored alias of the kit's VenueResult. */
export type CourtResult = VenueResult;

/** VenuePicker with court-flavored copy, our venue catalog, and no external provider. */
export default function CourtPicker({
  placeholder = 'Search for a court or venue...',
  skipLabel = 'Skip — no home court',
  localSearch = venueLocalSearch,
  catalogLabel = 'known courts',
  externalSearch = 'none',
  ...rest
}: VenuePickerProps) {
  return (
    <VenuePicker
      placeholder={placeholder}
      skipLabel={skipLabel}
      localSearch={localSearch}
      catalogLabel={catalogLabel}
      externalSearch={externalSearch}
      {...rest}
    />
  );
}
