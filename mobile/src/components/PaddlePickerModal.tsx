import React, { useEffect, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, TextInput,
  FlatList, StyleSheet, Pressable, ActivityIndicator,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';

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
  const styles = makeStyles(c);

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
    const { data } = await supabase.from('paddle_brands').select('id, name').order('sort_order');
    setBrands((data ?? []) as Brand[]);
    setLoading(false);
  }

  async function loadModels(brandId: string) {
    setLoadingModels(true);
    const { data } = await supabase
      .from('paddle_models')
      .select('id, name, thickness_mm, notes')
      .eq('brand_id', brandId)
      .order('sort_order');
    setDbModels((data ?? []) as DBModel[]);
    setLoadingModels(false);
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
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>

          {/* Header */}
          <View style={styles.header}>
            {step !== 'brand' ? (
              <TouchableOpacity onPress={() => setStep(step === 'thickness' ? 'model' : 'brand')}>
                <Text style={styles.back}>← Back</Text>
              </TouchableOpacity>
            ) : <View style={{ width: 60 }} />}
            <Text style={styles.title}>
              {step === 'brand' ? 'Select Brand'
               : step === 'model' ? selectedBrand?.name ?? 'Model'
               : 'Thickness'}
            </Text>
            <TouchableOpacity onPress={() => { reset(); onClose(); }} style={{ width: 36, alignItems: 'flex-end' }}>
              <Text style={styles.closeBtn}>✕</Text>
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
              {loading ? <ActivityIndicator style={{ margin: 24 }} color={c.primary} /> : (
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
                        <Text style={styles.chevron}>›</Text>
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
                <ActivityIndicator style={{ marginVertical: 16 }} color={c.primary} />
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
                        <View style={{ flex: 1 }}>
                          <Text style={styles.suggestName}>{item.name}</Text>
                          {(item.thickness_mm || item.notes) && (
                            <Text style={styles.suggestMeta}>
                              {[item.thickness_mm ? item.thickness_mm + 'mm' : null, item.notes].filter(Boolean).join(' · ')}
                            </Text>
                          )}
                        </View>
                        <Text style={styles.suggestArrow}>›</Text>
                      </TouchableOpacity>
                    )}
                  />
                </>
              ) : (
                <Text style={styles.noModels}>No models found — type your model name above.</Text>
              )}

              <TouchableOpacity
                style={[styles.nextBtn, !modelInput.trim() && styles.nextBtnDisabled]}
                onPress={() => modelInput.trim() && setStep('thickness')}
                disabled={!modelInput.trim()}
              >
                <Text style={styles.nextBtnText}>Next — Select Thickness</Text>
              </TouchableOpacity>
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
                  {thickness === opt.value && opt.value !== null && <Text style={styles.checkmark}>✓</Text>}
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
                <TouchableOpacity
                  style={[styles.customConfirm, !customThickness && styles.nextBtnDisabled]}
                  onPress={() => customThickness && confirmThickness(parseFloat(customThickness))}
                  disabled={!customThickness}
                >
                  <Text style={styles.customConfirmText}>Use</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

        </Pressable>
      </Pressable>
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    overlay:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    sheet:     { backgroundColor: c.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '88%', paddingBottom: 32 },
    header:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: c.border },
    back:      { fontSize: 15, color: c.primary, fontWeight: '600', width: 60 },
    title:     { fontSize: 17, fontWeight: '800', color: c.text, flex: 1, textAlign: 'center' },
    closeBtn:  { fontSize: 18, color: c.textMuted },
    steps:     { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingVertical: 10 },
    stepDot:       { width: 8, height: 8, borderRadius: 4, backgroundColor: c.border },
    stepDotActive: { backgroundColor: c.primary, width: 20 },
    stepDotDone:   { backgroundColor: c.primary + '88' },

    searchInput:  { margin: 12, marginBottom: 4, borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: c.text, backgroundColor: c.surface },
    list:         { maxHeight: 440 },
    brandRow:     { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.bg },
    brandName:    { flex: 1, fontSize: 16, fontWeight: '600', color: c.text },
    chevron:      { fontSize: 20, color: c.textMuted },

    modelContainer: { flex: 1, padding: 16 },
    modelInput:     { borderWidth: 1.5, borderColor: c.border, borderRadius: 10, padding: 14, fontSize: 16, marginBottom: 10, color: c.text, backgroundColor: c.surface },
    suggestLabel:   { fontSize: 12, color: c.textMuted, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
    suggestList:    { maxHeight: 260, marginBottom: 12 },
    suggestRow:     { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: c.bg },
    suggestName:    { fontSize: 14, fontWeight: '600', color: c.text },
    suggestMeta:    { fontSize: 11, color: c.textMuted, marginTop: 1 },
    suggestArrow:   { fontSize: 18, color: c.textMuted, marginLeft: 8 },
    noModels:       { fontSize: 13, color: c.textMuted, textAlign: 'center', paddingVertical: 20 },
    nextBtn:        { backgroundColor: c.primary, borderRadius: 10, padding: 15, alignItems: 'center', marginTop: 8 },
    nextBtnDisabled:{ backgroundColor: c.textMuted },
    nextBtnText:    { color: '#fff', fontWeight: '700', fontSize: 15 },

    thicknessContainer: { padding: 16 },
    selectedModelPreview: { fontSize: 13, color: c.textMuted, textAlign: 'center', marginBottom: 14, fontStyle: 'italic' },
    stepLabel:  { fontSize: 14, fontWeight: '700', color: c.textSub, marginBottom: 4 },
    stepHint:   { fontSize: 12, color: c.textMuted, marginBottom: 14 },
    thicknessRow:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1.5, borderColor: c.border, marginBottom: 10 },
    thicknessRowActive: { borderColor: c.primary, backgroundColor: c.primaryLight },
    thicknessLabel:       { fontSize: 16, fontWeight: '600', color: c.textSub },
    thicknessLabelActive: { color: c.primary },
    checkmark:    { fontSize: 18, color: c.primary, fontWeight: '800' },
    customRow:    { flexDirection: 'row', gap: 10, marginTop: 4 },
    customInput:  { flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 12, fontSize: 15, color: c.text, backgroundColor: c.surface },
    customConfirm:{ backgroundColor: c.primary, borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
    customConfirmText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  });
}
