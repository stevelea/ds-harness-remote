import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { Check, Laptop, Zap } from 'lucide-react-native'
import { friendlyError } from '../lib/errors'
import { normalizeDirectEndpoint } from '../lib/direct-endpoint'
import { strings as zhCN } from '../locales/i18n'
import { clearDirectEndpoint, loadDirectEndpoints, loadTrustedHosts, saveDirectEndpoint } from '../services/storage'
import { useAppStore } from '../state/store'
import type { RemoteDevice } from '../types'
import { BlurHeaderFrame, Button, EmptyState, ErrorBanner, Field, Screen, SectionTitle, SuccessNotice, TopBar } from '../ui/components'
import { useResponsiveLayout } from '../ui/responsive'
import { radius, spacing, type } from '../ui/theme'
import { useTheme, type ThemeColors } from '../ui/theme-context'
import { useThemedStyles } from '../ui/use-themed-styles'

/**
 * Serverless entry point for an already-trusted Host: the user saves a
 * Tailscale/private address and connects without the Server being reachable.
 * Once connected, the normal workspace/chat screens take over.
 */
export function DirectConnectScreen({ onBack, onConnected }: {
  onBack: () => void
  onConnected: () => void
}) {
  const connectDirect = useAppStore(state => state.connectDirectDevice)
  const clearError = useAppStore(state => state.clearError)
  const [hosts, setHosts] = useState<RemoteDevice[]>()
  const [endpoints, setEndpoints] = useState<Record<string, string>>({})
  const [selectedId, setSelectedId] = useState<string>()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState<'save' | 'clear' | 'connect'>()
  const { contentMaxWidth, landscape } = useResponsiveLayout()
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)

  useEffect(() => {
    let active = true
    void Promise.all([loadTrustedHosts(), loadDirectEndpoints()]).then(([trusted, saved]) => {
      if (!active) return
      const available = trusted.filter(host => host.trusted)
      const byDevice = Object.fromEntries(saved.map(item => [item.deviceId, item.endpoint]))
      setHosts(available)
      setEndpoints(byDevice)
      const first = available[0]
      if (first !== undefined) {
        setSelectedId(first.deviceId)
        setDraft(byDevice[first.deviceId] ?? '')
      }
    }).catch(loadError => {
      if (active) setError(friendlyError(loadError))
    })
    return () => { active = false }
  }, [])

  const selected = hosts?.find(host => host.deviceId === selectedId)
  const savedEndpoint = selected === undefined ? undefined : endpoints[selected.deviceId]

  const select = (host: RemoteDevice) => {
    setSelectedId(host.deviceId)
    setDraft(endpoints[host.deviceId] ?? '')
    setError(undefined)
    setNotice(undefined)
  }

  const validate = (): string | undefined => {
    try {
      return normalizeDirectEndpoint(draft)
    } catch (validationError) {
      setError(friendlyError(validationError))
      return undefined
    }
  }

  const save = async () => {
    if (selected === undefined || busy !== undefined) return
    setError(undefined)
    setNotice(undefined)
    const normalized = validate()
    if (normalized === undefined) return
    setBusy('save')
    try {
      await saveDirectEndpoint(selected.deviceId, normalized)
      setEndpoints(current => ({ ...current, [selected.deviceId]: normalized }))
      setDraft(normalized)
      setNotice(zhCN.direct.savedNotice)
    } catch (saveError) {
      setError(friendlyError(saveError))
    } finally {
      setBusy(undefined)
    }
  }

  const clear = async () => {
    if (selected === undefined || busy !== undefined) return
    setError(undefined)
    setNotice(undefined)
    setBusy('clear')
    try {
      await clearDirectEndpoint(selected.deviceId)
      setEndpoints(current => {
        const next = { ...current }
        delete next[selected.deviceId]
        return next
      })
      setDraft('')
      setNotice(zhCN.direct.clearedNotice)
    } catch (clearError) {
      setError(friendlyError(clearError))
    } finally {
      setBusy(undefined)
    }
  }

  const connect = async () => {
    if (selected === undefined || busy !== undefined) return
    setError(undefined)
    setNotice(undefined)
    const normalized = validate()
    if (normalized === undefined) return
    setBusy('connect')
    try {
      const connected = await connectDirect(selected, normalized)
      if (!connected) {
        setError(useAppStore.getState().error ?? zhCN.direct.failed)
        // The screen shows the failure inline; avoid a duplicate global banner.
        clearError()
        return
      }
      onConnected()
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <View style={styles.flex}>
      <BlurHeaderFrame header={<TopBar title={zhCN.direct.title} onBack={onBack} />}>
        <Screen>
          <View style={[styles.contentColumn, landscape && { maxWidth: contentMaxWidth }]}>
            <View style={styles.hero}>
              <View style={styles.heroIcon}><Zap size={26} color={colors.primary} /></View>
              <Text style={styles.lead}>{zhCN.direct.lead}</Text>
            </View>

            {error !== undefined && <ErrorBanner message={error} onDismiss={() => setError(undefined)} />}
            {notice !== undefined && <SuccessNotice>{notice}</SuccessNotice>}

            {hosts === undefined
              ? <View style={styles.loading}><ActivityIndicator size="small" color={colors.primary} /></View>
              : hosts.length === 0
                ? <EmptyState icon={Laptop} title={zhCN.direct.noHostsTitle} body={zhCN.direct.noHostsBody} />
                : <>
                    <SectionTitle>{zhCN.direct.hosts}</SectionTitle>
                    <View style={styles.group}>
                      {hosts.map(host => {
                        const active = host.deviceId === selectedId
                        return (
                          <Pressable
                            key={host.deviceId}
                            accessibilityRole="button"
                            accessibilityLabel={`${host.name}: ${endpoints[host.deviceId] ?? zhCN.direct.noSaved}`}
                            accessibilityState={{ selected: active }}
                            onPress={() => select(host)}
                            style={({ pressed }) => [styles.hostRow, pressed && styles.hostRowPressed]}
                          >
                            <View style={styles.hostIcon}><Laptop size={19} color={colors.primary} /></View>
                            <View style={styles.hostCopy}>
                              <Text style={styles.hostName} numberOfLines={1}>{host.name}</Text>
                              <Text style={styles.hostEndpoint} numberOfLines={1}>{endpoints[host.deviceId] ?? zhCN.direct.noSaved}</Text>
                            </View>
                            {active && <Check size={18} color={colors.primary} />}
                          </Pressable>
                        )
                      })}
                    </View>

                    <Field
                      label={zhCN.direct.address}
                      hint={zhCN.direct.addressHint}
                      placeholder={zhCN.direct.addressPlaceholder}
                      value={draft}
                      onChangeText={value => { setDraft(value); setError(undefined); setNotice(undefined) }}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                      editable={busy === undefined}
                    />
                    <View style={styles.actions}>
                      <Button
                        label={zhCN.direct.save}
                        variant="secondary"
                        onPress={() => void save()}
                        loading={busy === 'save'}
                        disabled={busy !== undefined || draft.trim().length === 0}
                      />
                      <Button
                        label={zhCN.direct.connect}
                        icon={Zap}
                        onPress={() => void connect()}
                        loading={busy === 'connect'}
                        disabled={busy !== undefined || draft.trim().length === 0}
                      />
                    </View>
                    {savedEndpoint !== undefined && (
                      <View style={styles.clearArea}>
                        <Button
                          label={zhCN.direct.clear}
                          variant="quiet"
                          onPress={() => void clear()}
                          loading={busy === 'clear'}
                          disabled={busy !== undefined}
                        />
                      </View>
                    )}
                  </>}
          </View>
        </Screen>
      </BlurHeaderFrame>
    </View>
  )
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.background },
    contentColumn: { width: '100%', alignSelf: 'center' },
    hero: { paddingTop: spacing.xl, paddingBottom: spacing.lg, alignItems: 'center', gap: spacing.sm },
    heroIcon: { width: 52, height: 52, borderRadius: radius.lg, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
    lead: { ...type.small, color: colors.muted, textAlign: 'center', maxWidth: 420 },
    loading: { minHeight: 160, alignItems: 'center', justifyContent: 'center' },
    group: { borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator, overflow: 'hidden' },
    hostRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
    hostRowPressed: { backgroundColor: colors.surfaceStrong },
    hostIcon: { width: 36, height: 36, borderRadius: radius.md, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
    hostCopy: { flex: 1, gap: 2 },
    hostName: { ...type.bodyStrong, color: colors.ink },
    hostEndpoint: { ...type.caption, color: colors.muted },
    actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
    clearArea: { marginTop: spacing.sm, alignItems: 'center' },
  })
}
