import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { absoluteUrl } from '@/lib/config';
import { colors } from '@/ui/theme';

export interface ArtworkProps {
  uri: string | null | undefined;
  size: number;
  radius: number;
  style?: StyleProp<ViewStyle>;
}

/** Обложка трека; без обложки — нейтральная плашка музыкального слоя. Декоративна для диктора. */
export function Artwork({ uri, size, radius, style }: ArtworkProps) {
  const src = absoluteUrl(uri);
  const box = { width: size, height: size, borderRadius: radius };
  if (!src) {
    return (
      <View style={[styles.fallback, box, style]} accessible={false} importantForAccessibility="no-hide-descendants">
        <Ionicons name="musical-notes" size={Math.round(size * 0.36)} color={colors.violet} />
      </View>
    );
  }
  return (
    <View style={[styles.frame, box, style]} accessible={false} importantForAccessibility="no-hide-descendants">
      <Image source={{ uri: src }} style={styles.image} contentFit="cover" transition={150} recyclingKey={src} cachePolicy="memory-disk" />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', backgroundColor: colors.surface2 },
  image: { width: '100%', height: '100%' },
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.violetSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
});
