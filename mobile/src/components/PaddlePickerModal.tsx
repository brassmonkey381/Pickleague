import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator,
} from 'react-native';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { Button, KeyboardTextInput } from '@just-messin-around/expo-foundation/forms';
import { BottomSheet, FilterSearchField } from '@just-messin-around/expo-foundation/ui';
import { SPACE, RADIUS, HAIRLINE, webInputFontFloor } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';

export type PaddleSelection = {
  brandId: string;
  brandName: string;
  modelName: string;
  thicknessMm: number | null;
};

type Brand   = { id: string; name: string };
type DBModel = { id: string; name: string; thickness_mm: number | null; notes: string | null };
type Step    = 'brand' | 'model' | 'thickness';

const THICKNESS_OPTIONS = [13, 14, 15, 16];
// A typed core thickness outside this range is a typo, not a paddle.
const MIN_MM = 5;
const MAX_MM = 30;

type Props = {
  visible: boolean;
  onSelect: (paddle: PaddleSelection) => void;
  onClose: () => void;
  initial?: PaddleSelection | null;
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Brand, then that brand's models, as tap lists. The search box never opens
 * the keyboard by itself: the keyboard used to come up over the model list
 * (autoFocus), hiding the presets. A catalog model with a known core
 * thickness saves on tap; a typed model, or one without a thickness, asks for
 * the thickness last.
 */
export default function PaddlePickerModal({ visible, onSelect, onClose, initial }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const styles = makeStyles(c);

  const [step, setStep]               = useState<Step>('brand');
  const [query, setQuery]             = useState('');
  const [brands, setBrands]           = useState<Brand[]>([]);
  const [brandsLoading, setBrandsLoading] = useState(false);
  const [brand, setBrand]             = useState<Brand | null>(null);
  const [models, setModels]           = useState<DBModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelName, setModelName]     = useState('');
  const [customMm, setCustomMm]       = useState('');
  // A failed catalog read must not render as "there are no brands/models".
  const [loadError, setLoadError]     = useState<string | null>(null);
  // The brand whose models were asked for last: a slow reply for a brand the
  // player has already backed out of must not fill the list.
  const modelsFor = useRef<string | null>(null);

  // Every open starts at the brand list, whatever step the last one closed on.
  useEffect(() => {
    if (!visible) return;
    setStep('brand');
    setQuery('');
    setBrand(null);
    setModelName('');
    setCustomMm('');
    if (brands.length === 0) loadBrands();
  }, [visible]);

  async function loadBrands() {
    setBrandsLoading(true);
    setLoadError(null);
    try {
      const data = await sbCall(() =>
        supabase.from('paddle_brands').select('id, name').order('sort_order'),
      );
      setBrands((data ?? []) as Brand[]);
    } catch (e) {
      setLoadError(friendlySbMessage(e, "Couldn't load paddle brands."));
    } finally {
      setBrandsLoading(false);
    }
  }

  async function loadModels(brandId: string) {
    modelsFor.current = brandId;
    setModels([]);
    setModelsLoading(true);
    setLoadError(null);
    try {
      const data = await sbCall(() => supabase
        .from('paddle_models')
        .select('id, name, thickness_mm, notes')
        .eq('brand_id', brandId)
        .order('sort_order'));
      if (modelsFor.current === brandId) setModels((data ?? []) as DBModel[]);
    } catch (e) {
      if (modelsFor.current === brandId) setLoadError(friendlySbMessage(e, "Couldn't load models for that brand."));
    } finally {
      if (modelsFor.current === brandId) setModelsLoading(false);
    }
  }

  function pickBrand(b: Brand) {
    setBrand(b);
    setQuery('');
    setStep('model');
    loadModels(b.id);
  }

  function finish(name: string, thicknessMm: number | null) {
    if (!brand) return;
    onSelect({ brandId: brand.id, brandName: brand.name, modelName: name.trim(), thicknessMm });
  }

  function pickModel(m: DBModel) {
    if (m.thickness_mm != null) { finish(m.name, Number(m.thickness_mm)); return; }
    setModelName(m.name);
    setCustomMm('');
    setStep('thickness');
  }

  function pickTyped(name: string) {
    setModelName(name.trim());
    setCustomMm('');
    setStep('thickness');
  }

  function goBack() {
    setQuery('');
    setLoadError(null);
    setStep(step === 'thickness' ? 'model' : 'brand');
  }

  const q = query.trim().toLowerCase();
  const shownBrands = q ? brands.filter(b => b.name.toLowerCase().includes(q)) : brands;
  const shownModels = q ? models.filter(m => m.name.toLowerCase().includes(q)) : models;
  // Typed text that isn't a listed model can still be saved as the player's own.
  const typed = query.trim();
  const offerTyped = step === 'model' && !modelsLoading && typed.length > 0 && !models.some(m => same(m.name, typed));

  const isCurrentBrand = (b: Brand) => initial?.brandId === b.id;
  const isCurrentModel = (name: string) =>
    !!initial && !!brand && initial.brandId === brand.id && same(initial.modelName, name);
  // The thickness already saved for this exact paddle, when changing it.
  const currentMm = modelName && isCurrentModel(modelName) ? initial?.thicknessMm ?? null : null;

  const mm = parseFloat(customMm);
  const customOk = Number.isFinite(mm) && mm >= MIN_MM && mm <= MAX_MM;

  const title = step === 'brand' ? 'Pick your paddle brand'
    : step === 'model' ? brand?.name ?? 'Model'
    : 'Core thickness';

  const retry = (onPress: () => void) => (
    <TouchableOpacity style={styles.message} onPress={onPress} accessibilityRole="button">
      <Text style={[t.hint, styles.center]}>{loadError}{'\n'}Tap to retry.</Text>
    </TouchableOpacity>
  );

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={title}
      onBack={step === 'brand' ? undefined : goBack}
      height="85%"
      keyboardShrink
      contentStyle={styles.body}
    >
      {/* ── BRAND ── */}
      {step === 'brand' && (
        brandsLoading ? <ActivityIndicator style={styles.spinner} color={c.primary} />
        : loadError ? retry(loadBrands)
        : (
          <>
            <FilterSearchField
              size="sm"
              value={query}
              onChangeText={setQuery}
              placeholder={`Search ${brands.length} brands`}
              autoCorrect={false}
              autoCapitalize="none"
              style={styles.search}
            />
            <FlatList
              data={shownBrands}
              keyExtractor={b => b.id}
              style={styles.list}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={<Text style={[t.hint, styles.message, styles.center]}>No brand matches "{typed}".</Text>}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.row}
                  onPress={() => pickBrand(item)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isCurrentBrand(item) }}
                >
                  <Text style={styles.rowName}>{item.name}</Text>
                  {isCurrentBrand(item) ? <Icon name="check-mark" size={18} color={c.primary} /> : null}
                  <Icon name="chevron-right" size={16} color={c.textMuted} />
                </TouchableOpacity>
              )}
            />
          </>
        )
      )}

      {/* ── MODEL ── */}
      {step === 'model' && (
        <>
          <FilterSearchField
            size="sm"
            value={query}
            onChangeText={setQuery}
            placeholder={models.length ? `Search ${models.length} models, or type yours` : 'Type your model'}
            autoCorrect={false}
            style={styles.search}
          />
          {modelsLoading ? <ActivityIndicator style={styles.spinner} color={c.primary} />
          : loadError && !offerTyped ? retry(() => brand && loadModels(brand.id))
          : (
            <FlatList
              data={shownModels}
              keyExtractor={m => m.id}
              style={styles.list}
              keyboardShouldPersistTaps="handled"
              ListHeaderComponent={offerTyped ? (
                <TouchableOpacity style={styles.row} onPress={() => pickTyped(typed)} accessibilityRole="button">
                  <Icon name="plus" size={18} color={c.primary} />
                  <View style={styles.flex1}>
                    <Text style={[styles.rowName, styles.primary]} numberOfLines={1}>Use "{typed}"</Text>
                    <Text style={t.caption}>Not in the list? Save it as you typed it.</Text>
                  </View>
                </TouchableOpacity>
              ) : null}
              ListEmptyComponent={offerTyped ? null : (
                <Text style={[t.hint, styles.message, styles.center]}>
                  No {brand?.name} models listed yet. Type yours in the box above.
                </Text>
              )}
              ListFooterComponent={models.length > 0 && !q ? (
                <Text style={[t.hint, styles.message, styles.center]}>Not listed? Type its name in the box above.</Text>
              ) : null}
              renderItem={({ item }) => {
                const meta = [item.thickness_mm != null ? `${Number(item.thickness_mm)} mm` : null, item.notes].filter(Boolean).join(' · ');
                const current = isCurrentModel(item.name);
                return (
                  <TouchableOpacity
                    style={styles.row}
                    onPress={() => pickModel(item)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: current }}
                  >
                    <View style={styles.flex1}>
                      <Text style={styles.rowName}>{item.name}</Text>
                      {meta ? <Text style={t.caption}>{meta}</Text> : null}
                    </View>
                    {current ? <Icon name="check-mark" size={18} color={c.primary} /> : null}
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </>
      )}

      {/* ── THICKNESS (typed models, or models with no listed thickness) ── */}
      {step === 'thickness' && (
        <View>
          <Text style={[t.hint, styles.center, styles.preview]}>{brand?.name} · {modelName}</Text>
          <Text style={[t.caption, styles.hintLine]}>Thicker = more control · Thinner = more power</Text>
          {THICKNESS_OPTIONS.map(v => {
            const active = currentMm != null && Number(currentMm) === v;
            return (
              <TouchableOpacity
                key={v}
                style={[styles.option, active && styles.optionActive]}
                onPress={() => finish(modelName, v)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.optionLabel, active && styles.primary]}>{v} mm</Text>
                {active ? <Icon name="check-mark" size={18} color={c.primary} /> : null}
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity style={styles.option} onPress={() => finish(modelName, null)} accessibilityRole="button">
            <Text style={styles.optionLabel}>Not sure</Text>
          </TouchableOpacity>
          <View style={styles.customRow}>
            <KeyboardTextInput
              style={[styles.customInput, webInputFontFloor(styles.customInput)]}
              placeholder="Other mm (e.g. 11.5)"
              placeholderTextColor={c.textMuted}
              keyboardType="decimal-pad"
              value={customMm}
              onChangeText={setCustomMm}
              returnKeyType="done"
              onSubmitEditing={() => customOk && finish(modelName, mm)}
            />
            <Button size="sm" title="Use" onPress={() => customOk && finish(modelName, mm)} disabled={!customOk} />
          </View>
        </View>
      )}
    </BottomSheet>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    body:     { paddingTop: SPACE.xs },
    search:   { marginBottom: SPACE.xs },
    list:     { flex: 1 },
    spinner:  { margin: SPACE.xl },
    message:  { paddingVertical: SPACE.lg, paddingHorizontal: SPACE.md },
    center:   { textAlign: 'center' },
    flex1:    { flex: 1, minWidth: 0 },
    primary:  { color: c.primary },
    row:      { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 48, paddingVertical: SPACE.sm, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    rowName:  { flex: 1, fontSize: FONT.size.lg, fontWeight: FONT.weight.semibold, color: c.text },

    preview:      { marginBottom: SPACE.xs, fontStyle: 'italic' },
    hintLine:     { textAlign: 'center', marginBottom: SPACE.md },
    option:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, paddingHorizontal: SPACE.lg, borderRadius: RADIUS.md, borderWidth: HAIRLINE, borderColor: c.border, marginBottom: SPACE.sm },
    optionActive: { borderColor: c.primary, backgroundColor: c.primaryLight },
    optionLabel:  { fontSize: FONT.size.lg, fontWeight: FONT.weight.semibold, color: c.textSub },
    customRow:    { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginTop: SPACE.xs },
    customInput:  { flex: 1, minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, fontSize: FONT.size.lg, color: c.text, backgroundColor: c.surface },
  });
}
