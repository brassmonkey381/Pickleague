import React, { useEffect, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, TextInput,
  FlatList, StyleSheet, Pressable, ActivityIndicator,
  Platform, useWindowDimensions,
} from 'react-native';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, RADIUS, HAIRLINE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';

const IS_WEB = Platform.OS === 'web';

export type PaddleSelection = {
  brandId: string;
  brandName: string;
  modelName: string;
  thicknessMm: number | null;
};

type Brand  = { id: string; name: string };
type DBModel = { id: string; name: string; thickness_mm: number | null; notes: string | null };
type Step   = 'brand' | 'model' | 'thickness';

const THICKNESS_OPTIONS = [
  { label: '13 mm', value: 13 },
  { label: '14 mm', value: 14 },
  { label: '15 mm', value: 15 },
  { label: '16 mm', value: 16 },
  { label: 'Other', value: null },
];

type Props = {
  visible: boolean;
  onSelect: (paddle: PaddleSelection) => void;
  onClose: () => void;
  initial?: PaddleSelection | null;
};

export default function PaddlePickerModal({ visible, onSelect, onClose, initial }: Props) {
  const { colors: c } = useTheme();
  const { height: winHeight } = useWindowDimensions();
  const listMaxHeight = Math.min(440, winHeight * 0.5);
  const suggestMaxHeight = Math.min(260, winHeight * 0.32);
  const styles = makeStyles(c, listMaxHeight, suggestMaxHeight);

  const [brands, setBrands]           = useState<Brand[]>([]);
  const [dbModels, setDbModels]       = useState<DBModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [step, setStep]               = useState<Step>('brand');
  const [selectedBrand, setSelectedBrand] = useState<Brand | null>(null);
  const [modelInput, setModelInput]   = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [thickness, setThickness]     = useState<number | null>(16);
  const [customThickness, setCustomThickness] = useState('');
  const [brandSearch, setBrandSearch] = useState('');
  const [loading, setLoading]         = useState(true);
  // A failed catalog read must not render as "there are no brands/models".
  const [loadError, setLoadError]     = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      loadBrands();
      if (initial) {
        setSelectedBrand({ id: initial.brandId, name: initial.brandName });
        setModelInput(initial.modelName);
        setThickness(initial.thicknessMm);
      } else {
        reset();
      }
    }
  }, [visible]);

  async function loadBrands() {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await sbCall(() =>
        supabase.from('paddle_brands').select('id, name').order('sort_order'),
      );
      setBrands((data ?? []) as Brand[]);
    } catch (e) {
      // An empty brand list looks like the catalog is empty, and there's no
      // way past step one — surface it so the user can retry.
      setLoadError(friendlySbMessage(e, "Couldn't load paddle brands."));
    } finally {
      setLoading(false);
    }
  }

  async function loadModels(brandId: string) {
    setLoadingModels(true);
    setLoadError(null);
    try {
      const data = await sbCall(() => supabase
        .from('paddle_models')
        .select('id, name, thickness_mm, notes')
        .eq('brand_id', brandId)
        .order('sort_order'));
      setDbModels((data ?? []) as DBModel[]);
    } catch (e) {
      setLoadError(friendlySbMessage(e, "Couldn't load models for that brand."));
    } finally {
      setLoadingModels(false);
    }
  }

  function reset() {
    setStep('brand');
    setSelectedBrand(null);
    setModelInput('');
    setModelSearch('');
    setThickness(16);
    setCustomThickness('');
    setBrandSearch('');
    setDbModels([]);
  }

  function pickBrand(brand: Brand) {
    setSelectedBrand(brand);
    setModelInput('');
    setModelSearch('');
    setStep('model');
    loadModels(brand.id);
  }

  function pickModel(model: DBModel) {
    setModelInput(model.name);
    if (model.thickness_mm) {
      // Pre-select the model's thickness and skip straight to confirm
      setThickness(model.thickness_mm);
      setStep('thickness');
    } else {
      setStep('thickness');
    }
  }

  function confirmThickness(val: number | null) {
    const finalThickness = val ?? (customThickness ? parseFloat(customThickness) : null);
    onSelect({
      brandId:      selectedBrand!.id,
      brandName:    selectedBrand!.name,
      modelName:    modelInput.trim(),
      thicknessMm:  finalThickness,
    });
    reset();
  }

  const filteredBrands = brandSearch.trim()
    ? brands.filter(b => b.name.toLowerCase().includes(brandSearch.toLowerCase()))
    : brands;

  const filteredModels = modelSearch.trim()
    ? dbModels.filter(m => m.name.toLowerCase().includes(modelSearch.toLowerCase()))
    : dbModels;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={styles.overlay}
        onPress={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <View style={styles.sheet}>

          {/* Header */}
          <View style={styles.header}>
            {step !== 'brand' ? (
              <TouchableOpacity
                onPress={() => setStep(step === 'thickness' ? 'model' : 'brand')}
                style={[styles.headerSide, styles.backBtn]}
                accessibilityRole="button"
                accessibilityLabel="Back"
              >
                <Icon name="chevron-left" size={18} color={c.primary} />
                <Text style={styles.back}>Back</Text>
              </TouchableOpacity>
            ) : <View style={styles.headerSide} />}
            <Text style={styles.title}>
              {step === 'brand' ? 'Select Brand'
               : step === 'model' ? selectedBrand?.name ?? 'Model'
               : 'Thickness'}
            </Text>
            <TouchableOpacity
              onPress={() => { reset(); onClose(); }}
              style={[styles.headerSide, styles.headerSideEnd]}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Icon name="close" size={20} color={c.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Step dots */}
          <View style={styles.steps}>
            {(['brand', 'model', 'thickness'] as Step[]).map((s, i) => {
              const done   = ['brand','model','thickness'].indexOf(step) > i;
              const active = step === s;
              return <View key={s} style={[styles.stepDot, active && styles.stepDotActive, done && styles.stepDotDone]} />;
            })}
          </View>

          {/* ── BRAND ── */}
          {step === 'brand' && (
            <>
              {loading ? <ActivityIndicator style={styles.spinner} color={c.primary} /> : loadError ? (
                <TouchableOpacity style={styles.retryBox} onPress={loadBrands} accessibilityRole="button">
                  <Text style={styles.noModels}>{loadError}{'\n'}Tap to retry.</Text>
                </TouchableOpacity>
              ) : (
                <>
                  <TextInput
                    style={styles.searchInput}
                    placeholder={`Search ${brands.length} brands…`}
                    placeholderTextColor={c.textMuted}
                    value={brandSearch}
                    onChangeText={setBrandSearch}
                    autoCorrect={false}
                  />
                  <FlatList
                    data={filteredBrands}
                    keyExtractor={b => b.id}
                    style={styles.list}
                    renderItem={({ item }) => (
                      <TouchableOpacity style={styles.brandRow} onPress={() => pickBrand(item)}>
                        <Text style={styles.brandName}>{item.name}</Text>
                        <Icon name="chevron-right" size={16} color={c.textMuted} />
                      </TouchableOpacity>
                    )}
                  />
                </>
              )}
            </>
          )}

          {/* ── MODEL ── */}
          {step === 'model' && (
            <View style={styles.modelContainer}>
              <TextInput
                style={styles.modelInput}
                placeholder="Type or search a model…"
                placeholderTextColor={c.textMuted}
                value={modelSearch || modelInput}
                onChangeText={v => { setModelSearch(v); setModelInput(v); }}
                autoFocus
                returnKeyType="next"
                onSubmitEditing={() => modelInput.trim() && setStep('thickness')}
              />

              {loadingModels ? (
                <ActivityIndicator style={styles.spinnerInline} color={c.primary} />
              ) : filteredModels.length > 0 ? (
                <>
                  <Text style={styles.suggestLabel}>
                    {modelSearch ? `${filteredModels.length} match${filteredModels.length !== 1 ? 'es' : ''}` : `${dbModels.length} known models`}
                  </Text>
                  <FlatList
                    data={filteredModels}
                    keyExtractor={m => m.id}
                    style={styles.suggestList}
                    keyboardShouldPersistTaps="handled"
                    renderItem={({ item }) => (
                      <TouchableOpacity style={styles.suggestRow} onPress={() => pickModel(item)}>
                        <View style={styles.flex1}>
                          <Text style={styles.suggestName}>{item.name}</Text>
                          {(item.thickness_mm || item.notes) && (
                            <Text style={styles.suggestMeta}>
                              {[item.thickness_mm ? item.thickness_mm + 'mm' : null, item.notes].filter(Boolean).join(' · ')}
                            </Text>
                          )}
                        </View>
                        <Icon name="chevron-right" size={16} color={c.textMuted} style={styles.suggestArrow} />
                      </TouchableOpacity>
                    )}
                  />
                </>
              ) : loadError ? (
                // Distinct from "no models" — one is a fact about the catalog,
                // the other is a fact about the network.
                <TouchableOpacity onPress={() => selectedBrand && loadModels(selectedBrand.id)} accessibilityRole="button">
                  <Text style={styles.noModels}>{loadError} Tap to retry — or just type your model above.</Text>
                </TouchableOpacity>
              ) : (
                <Text style={styles.noModels}>No models found — type your model name above.</Text>
              )}

              <Button
                title="Next — Select Thickness"
                onPress={() => modelInput.trim() && setStep('thickness')}
                disabled={!modelInput.trim()}
                style={styles.nextBtn}
              />
            </View>
          )}

          {/* ── THICKNESS ── */}
          {step === 'thickness' && (
            <View style={styles.thicknessContainer}>
              <Text style={styles.selectedModelPreview}>
                {selectedBrand?.name} · {modelInput}
              </Text>
              <Text style={styles.stepLabel}>Core thickness</Text>
              <Text style={styles.stepHint}>Thicker = more control  ·  Thinner = more power</Text>
              {THICKNESS_OPTIONS.map(opt => (
                <TouchableOpacity
                  key={String(opt.value)}
                  style={[styles.thicknessRow, thickness === opt.value && opt.value !== null && styles.thicknessRowActive]}
                  onPress={() => opt.value !== null ? confirmThickness(opt.value) : setThickness(null)}
                >
                  <Text style={[styles.thicknessLabel, thickness === opt.value && opt.value !== null && styles.thicknessLabelActive]}>
                    {opt.label}
                  </Text>
                  {thickness === opt.value && opt.value !== null && <Icon name="check-mark" size={18} color={c.primary} />}
                </TouchableOpacity>
              ))}
              <View style={styles.customRow}>
                <TextInput
                  style={styles.customInput}
                  placeholder="Custom mm (e.g. 11.5)"
                  placeholderTextColor={c.textMuted}
                  keyboardType="decimal-pad"
                  value={customThickness}
                  onChangeText={setCustomThickness}
                />
                <Button
                  size="sm"
                  title="Use"
                  onPress={() => customThickness && confirmThickness(parseFloat(customThickness))}
                  disabled={!customThickness}
                />
              </View>
            </View>
          )}

        </View>
      </Pressable>
    </Modal>
  );
}

function makeStyles(
  c: ReturnType<typeof useTheme>['colors'],
  listMaxHeight: number,
  suggestMaxHeight: number,
) {
  const t = textStyles(c);
  return StyleSheet.create({
    overlay:   {
      flex: 1,
      backgroundColor: c.backdrop,
      justifyContent: IS_WEB ? 'center' : 'flex-end',
      alignItems: IS_WEB ? 'center' : 'stretch',
      ...(IS_WEB ? { padding: SPACE.lg } : null),
    },
    sheet:     {
      backgroundColor: c.surface,
      borderTopLeftRadius: RADIUS.lg,
      borderTopRightRadius: RADIUS.lg,
      ...(IS_WEB
        ? {
            borderBottomLeftRadius: RADIUS.lg,
            borderBottomRightRadius: RADIUS.lg,
            maxWidth: 560,
            width: '100%',
            maxHeight: '90%',
          }
        : { maxHeight: '88%' }),
      paddingBottom: SPACE.xl,
    },
    header:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    // Both sides the same width so the title stays centred; real 44 boxes.
    headerSide:    { minWidth: 72, minHeight: 44, justifyContent: 'center' },
    headerSideEnd: { alignItems: 'flex-end' },
    backBtn:   { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs },
    back:      { fontSize: FONT.size.lg, color: c.primary, fontWeight: FONT.weight.semibold },
    title:     { ...t.h3, flex: 1, textAlign: 'center' },
    steps:     { flexDirection: 'row', justifyContent: 'center', gap: SPACE.sm, paddingVertical: SPACE.sm },
    stepDot:       { width: 8, height: 8, borderRadius: RADIUS.pill, backgroundColor: c.border },
    stepDotActive: { backgroundColor: c.primary, width: 20 },
    stepDotDone:   { backgroundColor: c.primary, opacity: 0.55 },

    spinner:       { margin: SPACE.xl },
    spinnerInline: { marginVertical: SPACE.lg },
    retryBox:      { padding: SPACE.xl },
    flex1:         { flex: 1, minWidth: 0 },

    searchInput:  { margin: SPACE.md, marginBottom: SPACE.xs, minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, fontSize: FONT.size.lg, color: c.text, backgroundColor: c.surface },
    list:         { maxHeight: listMaxHeight },
    brandRow:     { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44, paddingHorizontal: SPACE.lg, paddingVertical: SPACE.md, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    brandName:    { flex: 1, fontSize: FONT.size.lg, fontWeight: FONT.weight.semibold, color: c.text },

    modelContainer: { flex: 1, padding: SPACE.lg },
    modelInput:     { minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, padding: SPACE.md, fontSize: FONT.size.lg, marginBottom: SPACE.sm, color: c.text, backgroundColor: c.surface },
    suggestLabel:   { ...t.fieldLabel, marginBottom: SPACE.xs },
    suggestList:    { maxHeight: suggestMaxHeight, marginBottom: SPACE.md },
    suggestRow:     { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingVertical: SPACE.sm, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    suggestName:    { fontSize: FONT.size.md, fontWeight: FONT.weight.semibold, color: c.text },
    suggestMeta:    { ...t.caption, marginTop: SPACE.xxs },
    suggestArrow:   { marginLeft: SPACE.sm },
    noModels:       { ...t.hint, textAlign: 'center', paddingVertical: SPACE.lg },
    nextBtn:        { marginTop: SPACE.sm },

    thicknessContainer: { padding: SPACE.lg },
    selectedModelPreview: { ...t.hint, textAlign: 'center', marginBottom: SPACE.md, fontStyle: 'italic' },
    stepLabel:  { fontSize: FONT.size.md, fontWeight: FONT.weight.bold, color: c.textSub, marginBottom: SPACE.xs },
    stepHint:   { fontSize: FONT.size.sm, color: c.textMuted, marginBottom: SPACE.md },
    thicknessRow:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, paddingVertical: SPACE.md, paddingHorizontal: SPACE.lg, borderRadius: RADIUS.md, borderWidth: HAIRLINE, borderColor: c.border, marginBottom: SPACE.sm },
    thicknessRowActive: { borderColor: c.primary, backgroundColor: c.primaryLight },
    thicknessLabel:       { fontSize: FONT.size.lg, fontWeight: FONT.weight.semibold, color: c.textSub },
    thicknessLabelActive: { color: c.primary },
    customRow:    { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginTop: SPACE.xs },
    customInput:  { flex: 1, minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, padding: SPACE.md, fontSize: FONT.size.lg, color: c.text, backgroundColor: c.surface },
  });
}
