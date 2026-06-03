import React from 'react';
import { Pressable, StyleSheet, View, ViewStyle, StyleProp } from 'react-native';

interface ModalBackdropProps {
  onDismiss: () => void;
  children: React.ReactNode;
  /** Override the backdrop tint. Defaults to rgba(0,0,0,0.5). */
  backdropColor?: string;
  /** Override the backdrop layout (e.g. justifyContent: 'flex-end' for bottom sheets). */
  style?: StyleProp<ViewStyle>;
  /** Override the inner content container's style. */
  contentStyle?: StyleProp<ViewStyle>;
}

/**
 * Modal backdrop that closes on outside-tap and lets clicks on children pass through.
 * Pair with React Native's <Modal> as the immediate child to provide a centered card
 * (or override `style` with `justifyContent: 'flex-end'` for a bottom-sheet feel).
 *
 * Example:
 *   <Modal visible={visible} transparent onRequestClose={onClose}>
 *     <ModalBackdrop onDismiss={onClose}>
 *       <View style={{ width: '100%', maxWidth: 480, backgroundColor: c.surface, borderRadius: 14, padding: 16 }}>
 *         ...
 *       </View>
 *     </ModalBackdrop>
 *   </Modal>
 */
export function ModalBackdrop({ onDismiss, children, backdropColor, style, contentStyle }: ModalBackdropProps) {
  const tint = backdropColor ?? 'rgba(0,0,0,0.5)';
  return (
    <Pressable
      style={[styles.backdrop, { backgroundColor: tint }, style]}
      onPress={(e: any) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <View style={[styles.content, contentStyle]}>{children}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  content: {
    width: '100%',
    alignItems: 'center',
  },
});
