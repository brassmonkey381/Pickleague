import React, { useEffect, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, TextInput,
  FlatList, StyleSheet, Pressable, ActivityIndicator,
} from 'react-native';
import { supabase } from '../lib/supabase';

export type PaddleSelection = {
  brandId: string;
  brandName: string;
  modelName: string;
  thicknessMm: number | null;
};

type Brand = { id: string; name: string };
type Step = 'brand' | 'model' | 'thickness';

const THICKNESS_OPTIONS = [
  { label: '13 mm', value: 13 },
  { label: '14 mm', value: 14 },
  { label: '16 mm', value: 16 },
  { label: 'Other', value: null },
];

// Common models per brand for quick-select suggestions
const BRAND_MODELS: Record<string, string[]> = {
  'JOOLA':       ['Ben Johns Hyperion CFS 16', 'Perseus CFS 16', 'Solaire CFS 14', 'Vision CGS 16'],
  'Selkirk':     ['Vanguard Power Air Invikta', 'SLK Halo XL', 'Epic Polymer Core', 'Amped S2'],
  'CRBN':        ['CRBN 1X Power Series', 'CRBN 2X', 'CRBN 3X'],
  'Gearbox':     ['GX6 Power', 'Pro S 14mm', 'CX14E'],
  'Paddletek':   ['Tempest Wave Pro', 'Bantam TS-5 Pro', 'Phoenix G6'],
  'Engage':      ['Pursuit MX 6.0', 'Poach Infinity EX', 'Encore MX 6.0'],
  'Franklin':    ['Ben Johns Signature 13mm', 'Signature Pickleball Pro'],
  'Head':        ['Radical Pro', 'Extreme Pro', 'Gravity Pro'],
  'Vatic Pro':   ['Flash 14mm', 'Prism 14mm', 'V7 14mm'],
  'Electrum':    ['Model E Pro', 'Model E 16mm'],
  'ProKennex':   ['Pro Speed 14mm', 'Black Ace 14mm'],
  'Onix':        ['Evoke Premier', 'Stryker 4 Composite'],
  'Gamma':       ['Compass 206', 'NeuCore Needle 14mm'],
  'Babolat':     ['RBEL Touch 13', 'RBEL Air Viper'],
};

type Props = {
  visible: boolean;
  onSelect: (paddle: PaddleSelection) => void;
  onClose: () => void;
  initial?: PaddleSelection | null;
};

export default function PaddlePickerModal({ visible, onSelect, onClose, initial }: Props) {
  const [brands, setBrands]       = useState<Brand[]>([]);
  const [step, setStep]           = useState<Step>('brand');
  const [selectedBrand, setSelectedBrand] = useState<Brand | null>(null);
  const [modelInput, setModelInput]       = useState('');
  const [thickness, setThickness]         = useState<number | null>(14);
  const [customThickness, setCustomThickness] = useState('');
  const [brandSearch, setBrandSearch]     = useState('');
  const [loading, setLoading]             = useState(true);

  useEffect(() => {
    if (visible) {
      loadBrands();
      // Pre-fill from initial value
      if (initial) {
        setSelectedBrand({ id: initial.brandId, name: initial.brandName });
        setModelInput(initial.modelName);
        setThickness(initial.thicknessMm);
        setStep('brand');
      } else {
        setStep('brand');
        setSelectedBrand(null);
        setModelInput('');
        setThickness(14);
      }
    }
  }, [visible]);

  async function loadBrands() {
    setLoading(true);
    const { data } = await supabase.from('paddle_brands').select('id, name').order('sort_order');
    setBrands((data ?? []) as Brand[]);
    setLoading(false);
  }

  function pickBrand(brand: Brand) {
    setSelectedBrand(brand);
    setModelInput('');
    setStep('model');
  }

  function confirmModel() {
    if (!modelInput.trim()) return;
    setStep('thickness');
  }

  function confirmThickness(val: number | null) {
    setThickness(val);
    const finalThickness = val ?? (customThickness ? parseFloat(customThickness) : null);
    onSelect({
      brandId: selectedBrand!.id,
      brandName: selectedBrand!.name,
      modelName: modelInput.trim(),
      thicknessMm: finalThickness,
    });
  }

  const filteredBrands = brandSearch.trim()
    ? brands.filter(b => b.name.toLowerCase().includes(brandSearch.toLowerCase()))
    : brands;

  const suggestions = selectedBrand ? (BRAND_MODELS[selectedBrand.name] ?? []) : [];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>

          {/* Header */}
          <View style={styles.header}>
            {step !== 'brand' && (
              <TouchableOpacity onPress={() => setStep(step === 'thickness' ? 'model' : 'brand')}>
                <Text style={styles.back}>← Back</Text>
              </TouchableOpacity>
            )}
            <Text style={styles.title}>
              {step === 'brand' ? 'Select Brand' : step === 'model' ? `${selectedBrand?.name} — Model` : 'Thickness'}
            </Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.closeBtn}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* Step indicator */}
          <View style={styles.steps}>
            {(['brand', 'model', 'thickness'] as Step[]).map((s, i) => (
              <View key={s} style={[styles.stepDot, step === s && styles.stepDotActive, i < ['brand','model','thickness'].indexOf(step) && styles.stepDotDone]} />
            ))}
          </View>

          {/* ── Brand selection ── */}
          {step === 'brand' && (
            <>
              {loading ? <ActivityIndicator style={{ margin: 24 }} color="#2e7d32" /> : (
                <>
                  <TextInput
                    style={styles.searchInput}
                    placeholder="Search brands…"
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

          {/* ── Model selection ── */}
          {step === 'model' && (
            <View style={styles.modelContainer}>
              <Text style={styles.stepLabel}>Enter your paddle model</Text>
              <TextInput
                style={styles.modelInput}
                placeholder="e.g. Ben Johns Hyperion CFS 16"
                value={modelInput}
                onChangeText={setModelInput}
                autoFocus
                returnKeyType="next"
                onSubmitEditing={confirmModel}
              />
              {suggestions.length > 0 && (
                <>
                  <Text style={styles.suggestLabel}>Popular {selectedBrand?.name} models</Text>
                  <FlatList
                    data={suggestions}
                    keyExtractor={s => s}
                    style={styles.suggestList}
                    renderItem={({ item }) => (
                      <TouchableOpacity style={styles.suggestRow} onPress={() => setModelInput(item)}>
                        <Text style={styles.suggestText}>{item}</Text>
                      </TouchableOpacity>
                    )}
                  />
                </>
              )}
              <TouchableOpacity
                style={[styles.nextBtn, !modelInput.trim() && styles.nextBtnDisabled]}
                onPress={confirmModel}
                disabled={!modelInput.trim()}
              >
                <Text style={styles.nextBtnText}>Next — Select Thickness</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ── Thickness selection ── */}
          {step === 'thickness' && (
            <View style={styles.thicknessContainer}>
              <Text style={styles.stepLabel}>Core thickness</Text>
              <Text style={styles.stepHint}>Thicker = more control · Thinner = more power</Text>
              {THICKNESS_OPTIONS.map(opt => (
                <TouchableOpacity
                  key={String(opt.value)}
                  style={[styles.thicknessRow, thickness === opt.value && opt.value !== null && styles.thicknessRowActive]}
                  onPress={() => {
                    if (opt.value !== null) {
                      confirmThickness(opt.value);
                    } else {
                      setThickness(null);
                    }
                  }}
                >
                  <Text style={[styles.thicknessLabel, thickness === opt.value && opt.value !== null && styles.thicknessLabelActive]}>
                    {opt.label}
                  </Text>
                  {thickness === opt.value && opt.value !== null && <Text style={styles.checkmark}>✓</Text>}
                </TouchableOpacity>
              ))}
              {/* Custom thickness */}
              <View style={styles.customRow}>
                <TextInput
                  style={styles.customInput}
                  placeholder="Custom mm (e.g. 11.5)"
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

const GREEN = '#2e7d32';
const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '85%', paddingBottom: 32 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: '#eee' },
  back: { fontSize: 15, color: GREEN, fontWeight: '600', minWidth: 60 },
  title: { fontSize: 17, fontWeight: '800', color: '#1a1a1a', flex: 1, textAlign: 'center' },
  closeBtn: { fontSize: 18, color: '#aaa', minWidth: 36, textAlign: 'right' },
  steps: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingVertical: 10 },
  stepDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ddd' },
  stepDotActive: { backgroundColor: GREEN, width: 20 },
  stepDotDone: { backgroundColor: GREEN + '88' },
  searchInput: { margin: 12, marginBottom: 4, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  list: { maxHeight: 400 },
  brandRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  brandName: { flex: 1, fontSize: 16, fontWeight: '600', color: '#1a1a1a' },
  chevron: { fontSize: 20, color: '#ccc' },
  modelContainer: { padding: 16 },
  stepLabel: { fontSize: 14, fontWeight: '700', color: '#333', marginBottom: 8 },
  stepHint: { fontSize: 12, color: '#aaa', marginBottom: 16 },
  modelInput: { borderWidth: 1.5, borderColor: '#ddd', borderRadius: 10, padding: 14, fontSize: 16, marginBottom: 16 },
  suggestLabel: { fontSize: 12, color: '#888', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  suggestList: { maxHeight: 180, marginBottom: 16 },
  suggestRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  suggestText: { fontSize: 14, color: '#555' },
  nextBtn: { backgroundColor: GREEN, borderRadius: 10, padding: 15, alignItems: 'center' },
  nextBtnDisabled: { backgroundColor: '#ccc' },
  nextBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  thicknessContainer: { padding: 16 },
  thicknessRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1.5, borderColor: '#eee', marginBottom: 10 },
  thicknessRowActive: { borderColor: GREEN, backgroundColor: '#f0faf0' },
  thicknessLabel: { fontSize: 16, fontWeight: '600', color: '#333' },
  thicknessLabelActive: { color: GREEN },
  checkmark: { fontSize: 18, color: GREEN, fontWeight: '800' },
  customRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  customInput: { flex: 1, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, fontSize: 15 },
  customConfirm: { backgroundColor: GREEN, borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
  customConfirmText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
