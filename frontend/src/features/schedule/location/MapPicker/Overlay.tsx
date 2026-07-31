import { useCallback, useEffect, useRef, useState } from 'react';
import { LocateFixed, MapPin, Search } from 'lucide-react-native';
import { Pressable, Text, TextInput, View } from 'react-native';

import { colors } from '@/shared/theme';
import { BackButton } from '@/shared/components/BackButton';
import { mapPickerStyles as styles } from './styles';
import type { MapLocation } from './types';

type MapPickerOverlayProps = {
  mapError: string | null;
  mapReady: boolean;
  locating: boolean;
  locationError: string | null;
  onCancel: () => void;
  onLocate: () => void;
  onConfirm: () => void;
  onSearch: (query: string) => Promise<MapLocation[]>;
  onSelectSearchResult: (location: MapLocation) => void;
  selection: MapLocation | null;
};

export function MapPickerOverlay({
  mapError,
  mapReady,
  locating,
  locationError,
  onCancel,
  onLocate,
  onConfirm,
  onSearch,
  onSelectSearchResult,
  selection,
}: MapPickerOverlayProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MapLocation[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const searchRequestRef = useRef(0);

  const search = useCallback(
    async (value: string) => {
      const nextQuery = value.trim();
      if (!nextQuery || !mapReady) return;

      const requestId = searchRequestRef.current + 1;
      searchRequestRef.current = requestId;
      setSearching(true);
      setSearched(false);
      setSearchFailed(false);
      try {
        const nextResults = await onSearch(nextQuery);
        if (requestId !== searchRequestRef.current) return;
        setResults(nextResults);
        setSearched(true);
      } catch {
        if (requestId !== searchRequestRef.current) return;
        setResults([]);
        setSearchFailed(true);
      } finally {
        if (requestId === searchRequestRef.current) setSearching(false);
      }
    },
    [mapReady, onSearch],
  );

  useEffect(() => {
    const nextQuery = query.trim();
    if (!nextQuery || !mapReady) return;

    const timer = setTimeout(() => {
      void search(nextQuery);
    }, 320);
    return () => clearTimeout(timer);
  }, [mapReady, query, search]);

  const chooseResult = (location: MapLocation) => {
    searchRequestRef.current += 1;
    setSearching(false);
    setQuery('');
    setResults([]);
    setSearched(false);
    onSelectSearchResult(location);
  };

  return (
    <>
      <View style={styles.topArea}>
        <View style={styles.toolbar}>
          <BackButton accessibilityLabel="退出地图选点" onPress={onCancel} />
          <View style={styles.searchBox}>
            <Search color={colors.sub} size={16} strokeWidth={2} />
            <TextInput
              accessibilityLabel="搜索地点"
              onChangeText={(value) => {
                setQuery(value);
                searchRequestRef.current += 1;
                setSearching(false);
                setSearchFailed(false);
                setSearched(false);
                if (!value.trim()) {
                  setResults([]);
                }
              }}
              onSubmitEditing={() => void search(query)}
              placeholder="搜索地点或地址"
              placeholderTextColor="#909892"
              returnKeyType="search"
              style={styles.searchInput}
              value={query}
            />
            <Pressable
              accessibilityLabel="提交地点搜索"
              accessibilityRole="button"
              disabled={!mapReady || !query.trim() || searching}
              onPress={() => void search(query)}
              style={styles.searchButton}
            >
              <Search color={colors.deep} size={15} strokeWidth={2.1} />
            </Pressable>
          </View>
          <Pressable
            accessibilityLabel="定位到当前位置"
            accessibilityRole="button"
            disabled={!mapReady || locating}
            onPress={onLocate}
            style={[styles.locateButton, locating && styles.locateButtonActive]}
          >
            <LocateFixed color={colors.deep} size={18} strokeWidth={2.1} />
          </Pressable>
        </View>

        {(searching || searchFailed || searched) && (
          <View style={styles.searchResults}>
            {searching ? (
              <Text style={styles.searchMessage}>正在搜索...</Text>
            ) : searchFailed ? (
              <Text style={styles.searchMessage}>搜索暂时不可用，请直接在地图上选点</Text>
            ) : results.length === 0 ? (
              <Text style={styles.searchMessage}>没有找到相关地点</Text>
            ) : (
              results.map((result, index) => (
                <Pressable
                  accessibilityLabel={`选择 ${result.address}`}
                  accessibilityRole="button"
                  key={`${result.latitude}-${result.longitude}`}
                  onPress={() => chooseResult(result)}
                  style={[
                    styles.searchResult,
                    index === results.length - 1 && styles.searchResultLast,
                  ]}
                >
                  <MapPin color="#657C53" size={15} strokeWidth={2} />
                  <Text numberOfLines={2} style={styles.searchResultText}>
                    {result.address}
                  </Text>
                </Pressable>
              ))
            )}
          </View>
        )}
        {locationError ? (
          <View style={styles.locationError}>
            <Text style={styles.locationErrorText}>{locationError}</Text>
          </View>
        ) : null}
      </View>

      {mapError && (
        <View style={styles.mapError}>
          <MapPin color="#657C53" size={22} strokeWidth={2} />
          <Text style={styles.mapErrorTitle}>百度地图暂时不可用</Text>
          <Text style={styles.mapErrorText}>{mapError}</Text>
        </View>
      )}

      <View style={styles.selectionCard}>
        <View style={styles.selectionHeading}>
          <View style={styles.selectionIcon}>
            <MapPin color="#657C53" size={18} strokeWidth={2.1} />
          </View>
          <View style={styles.selectionCopy}>
            <Text style={styles.selectionKicker}>选中的地点</Text>
            {selection ? (
              <Text numberOfLines={2} style={styles.selectionAddress}>
                {locating ? '正在获取详细地址...' : selection.address}
              </Text>
            ) : locating ? (
              <Text style={styles.selectionHint}>正在获取当前位置...</Text>
            ) : (
              <Text style={styles.selectionHint}>点击地图，或搜索后选择一个地点</Text>
            )}
          </View>
        </View>
        {selection && (
          <Text style={styles.selectionMeta}>
            {selection.latitude.toFixed(5)}, {selection.longitude.toFixed(5)} · 百度地图 · BD-09
          </Text>
        )}
        <Pressable
          accessibilityLabel="确认选中的地址"
          accessibilityRole="button"
          disabled={!selection || locating || !mapReady}
          onPress={onConfirm}
          style={[
            styles.confirmButton,
            (!selection || locating || !mapReady) && styles.confirmButtonDisabled,
          ]}
        >
          <Text style={styles.confirmButtonText}>确认这个地点</Text>
        </Pressable>
      </View>
    </>
  );
}
