import { useCallback, useMemo, useState } from 'react';

import type { SavedLocation } from './types';
import { upsertSavedLocation } from './utils';

/**
 * App-session scoped saved locations.
 *
 * Persistence is intentionally not implied: a host can replace this hook with
 * a storage-backed provider once a cross-platform storage adapter is part of
 * the composition root.
 */
export function useSessionSavedLocations() {
  const [locations, setLocations] = useState<SavedLocation[]>([]);

  const upsert = useCallback((location: SavedLocation) => {
    setLocations((current) => upsertSavedLocation(current, location));
  }, []);

  return useMemo(() => ({ locations, upsert }), [locations, upsert]);
}
