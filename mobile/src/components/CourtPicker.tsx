// Thin backward-compat shim around the kit's generic VenuePicker. Retargeted
// off the kit's deprecated CourtPicker wrapper (removed in kit 1.0.0) — this
// shim now supplies the original court-flavored default copy locally so every
// `../components/CourtPicker` consumer sees zero change. Platform resolution
// (.tsx / .web.tsx) still happens inside the package's VenuePicker pair.
//
// It also wires our own venue catalog (public.venues) in as `localSearch`, so
// known courts surface above the external provider (Google/Nominatim) — a
// dual-run. Consumers can override localSearch/catalogLabel like any prop.
import React from 'react';
import { VenuePicker, type VenuePickerProps, type VenueResult } from '@just-messin-around/expo-foundation/ui';
import { venueLocalSearch } from '../lib/venues';

/** Court-flavored alias of the kit's VenueResult. */
export type CourtResult = VenueResult;

/** VenuePicker with the original court-flavored default copy + our venue catalog. */
export default function CourtPicker({
  placeholder = 'Search for a court or venue...',
  skipLabel = 'Skip — no home court',
  localSearch = venueLocalSearch,
  catalogLabel = 'known courts',
  ...rest
}: VenuePickerProps) {
  return (
    <VenuePicker
      placeholder={placeholder}
      skipLabel={skipLabel}
      localSearch={localSearch}
      catalogLabel={catalogLabel}
      {...rest}
    />
  );
}
