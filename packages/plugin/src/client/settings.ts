import type { LocalizedMessage, Translate } from '../client-locale.js'
import type { StatusFeed } from '../status-stream.js'
import {
  connectionErrorMessage,
  connectionStatusClass,
  connectionStatusLabel,
  directStatusErrorLabel,
  formatLocalTime,
  messageOf,
} from './presentation.js'
import type { ClientReact, DirectHostStatus, PluginAssociation, PluginSettingsView, RemoteStatus } from './types.js'

/** Mirrors DEFAULT_DIRECT_PORT in ../config.ts; the Host always reports its resolved value. */
const DIRECT_PORT_FALLBACK = 47400

export function createRemotePluginOptions(React: ClientReact) {
  function RemotePluginOptions(props: {
    control: <T>(endpoint: string, payload?: unknown) => Promise<T>
    statusFeed: StatusFeed<RemoteStatus>
    onSignIn: () => void
    t: Translate
    view?: 'summary' | 'page'
  }): unknown {
    const { t } = props
    const [open, setOpen] = React.useState(props.view === 'page')
    const [serverUrl, setServerUrl] = React.useState('')
    const [remoteToolsBusy, setRemoteToolsBusy] = React.useState(false)
    const [remoteToolsEnabled, setRemoteToolsEnabled] = React.useState(true)
    const role = 'host' as const
    const [associations, setAssociations] = React.useState<Partial<Record<'host' | 'client', PluginAssociation>>>({})
    const [loaded, setLoaded] = React.useState(false)
    const [writable, setWritable] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [terminalEnabled, setTerminalEnabled] = React.useState(false)
    const [terminalBusy, setTerminalBusy] = React.useState(false)
    const [directEnabled, setDirectEnabled] = React.useState(false)
    const [directPort, setDirectPort] = React.useState(String(DIRECT_PORT_FALLBACK))
    const [directStatus, setDirectStatus] = React.useState<DirectHostStatus | undefined>(undefined)
    const [directBusy, setDirectBusy] = React.useState(false)
    const [acpBackends, setAcpBackends] = React.useState<Array<{ id: string; enabled: boolean }>>([])
    const [acpAvailability, setAcpAvailability] = React.useState<Record<string, boolean>>({})
    const [acpChecking, setAcpChecking] = React.useState<Record<string, boolean>>({})
    const [acpCheckResults, setAcpCheckResults] = React.useState<Record<string, boolean | undefined>>({})
    const [reconnectBusy, setReconnectBusy] = React.useState(false)
    const [hostStatus, setHostStatus] = React.useState<RemoteStatus['host'] | undefined>(undefined)
    const [hostName, setHostName] = React.useState('')
    const [hostDeviceId, setHostDeviceId] = React.useState('')
    const [notice, setNotice] = React.useState<LocalizedMessage | undefined>(undefined)
    const [error, setError] = React.useState<string | undefined>(undefined)
    const [settingsView, setSettingsView] = React.useState<PluginSettingsView | undefined>(undefined)
    const associationReadRun = React.useRef(0)
    const association = associations.client ?? associations.host

    const applyAssociations = (view: PluginSettingsView): void => {
      setAssociations(view.associations ?? (view.association === undefined ? {} : { host: view.association }))
    }

    const applyView = (view: PluginSettingsView, updateAssociations = true): void => {
      setSettingsView(view)
      setServerUrl(view.config.serverUrl ?? 'https://dsh.r2049.cn')
      setTerminalEnabled(view.config.terminal?.enabled ?? true)
      setDirectEnabled(view.config.direct?.enabled === true)
      setDirectPort(String(view.config.direct?.port ?? DIRECT_PORT_FALLBACK))
      setDirectStatus(view.direct)
      setRemoteToolsEnabled(view.config.remoteTools?.enabled ?? true)
      setAcpBackends((view.config.acp?.backends ?? []).map(item => ({ id: item.id, enabled: item.enabled !== false })))
      setAcpAvailability(view.acpAvailability ?? {})
      if (updateAssociations) applyAssociations(view)
      setWritable(view.writable)
      setLoaded(true)
    }

    const load = async (): Promise<void> => {
      const run = ++associationReadRun.current
      const [view, status] = await Promise.all([
        props.control<PluginSettingsView>('settings.get'),
        props.control<RemoteStatus>('status').catch(() => undefined),
      ])
      applyView(view, run === associationReadRun.current)
      setHostStatus(status?.host)
      setHostName(status?.deviceName ?? '')
      setHostDeviceId(status?.host?.deviceId ?? '')
    }

    React.useEffect(() => {
      void load().catch(reason => setError(messageOf(reason)))
    }, [])

    React.useEffect(() => {
      let active = true
      let authorizationKey: string | undefined
      const unsubscribe = props.statusFeed.subscribe(status => {
        setHostStatus(status.host)
        setHostName(status.deviceName ?? '')
        setHostDeviceId(status.host?.deviceId ?? '')
        // Either account entry point rotates these identities on sign-out.
        // Refresh the read-only settings snapshot on that change without
        // fetching settings for ordinary connection/statistics updates.
        const key = JSON.stringify([status.serverUrl, status.deviceId, status.host?.deviceId,
          status.host?.authorized, status.host?.account])
        if (key === authorizationKey) return
        authorizationKey = key
        const run = ++associationReadRun.current
        void props.control<PluginSettingsView>('settings.get').then(view => {
          if (active && run === associationReadRun.current) applyView(view)
        }).catch(() => undefined)
      })
      return () => { active = false; unsubscribe() }
    }, [props.statusFeed])

    const logout = async (): Promise<void> => {
      const run = ++associationReadRun.current
      setBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        const view = await props.control<PluginSettingsView>('settings.logout')
        applyView(view, run === associationReadRun.current)
        setNotice({ key: 'signedOut' })
      } catch (reason) {
        setError(messageOf(reason))
      } finally {
        setBusy(false)
      }
    }

    const reconnectHost = async (): Promise<void> => {
      setReconnectBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        const status = await props.control<RemoteStatus>('host.reconnect')
        setHostStatus(status.host)
        setNotice({ key: 'reconnectStarted' })
      } catch (reason) {
        setError(messageOf(reason))
      } finally {
        setReconnectBusy(false)
      }
    }

    const setCurrentDeviceControl = async (enabled: boolean): Promise<void> => {
      setBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        const status = await props.control<RemoteStatus>('host.authorization.set', { enabled })
        setHostStatus(status.host)
      } catch (reason) {
        setError(messageOf(reason))
      } finally {
        setBusy(false)
      }
    }

    const setTerminalRemote = async (enabled: boolean): Promise<void> => {
      const previous = terminalEnabled
      setTerminalEnabled(enabled)
      setTerminalBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        const view = await props.control<PluginSettingsView>('settings.development.set', { terminalEnabled: enabled })
        applyView(view)
        setNotice({ key: 'terminalSaved' })
      } catch (reason) {
        setTerminalEnabled(previous)
        setError(messageOf(reason))
      } finally {
        setTerminalBusy(false)
      }
    }

    const setRemoteTools = async (enabled: boolean): Promise<void> => {
      setRemoteToolsBusy(true); setError(undefined); setNotice(undefined)
      try {
        // Include the terminal value for compatibility with older Hosts whose
        // development settings endpoint requires one of the legacy fields.
        const view = await props.control<PluginSettingsView>('settings.development.set', { remoteToolsEnabled: enabled, terminalEnabled })
        applyView(view)
        setNotice({ key: 'remoteToolsSaved' })
      }
      catch (reason) { setRemoteToolsEnabled(!enabled); setError(messageOf(reason)) }
      finally { setRemoteToolsBusy(false) }
    }

    const commitDirect = async (enabled: boolean, port: number, rollback: () => void): Promise<void> => {
      setDirectBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        const view = await props.control<PluginSettingsView>('settings.direct.set', { enabled, port })
        applyView(view)
        setNotice({ key: 'directSaved' })
      } catch (reason) {
        rollback()
        setError(messageOf(reason))
      } finally {
        setDirectBusy(false)
      }
    }

    const parsedDirectPort = (): number | undefined => {
      const port = Number(directPort.trim())
      return Number.isSafeInteger(port) && port >= 1024 && port <= 65535 ? port : undefined
    }

    const toggleDirect = (enabled: boolean): void => {
      const port = parsedDirectPort()
      if (port === undefined) { setError(t('directPortInvalid')); return }
      setDirectEnabled(enabled)
      void commitDirect(enabled, port, () => setDirectEnabled(!enabled))
    }

    const saveDirectPort = (): void => {
      const port = parsedDirectPort()
      if (port === undefined) { setError(t('directPortInvalid')); return }
      void commitDirect(directEnabled, port, () => undefined)
    }

    const checkAcp = async (backend: string): Promise<void> => {
      if (acpChecking[backend]) return
      setAcpChecking(current => ({ ...current, [backend]: true }))
      setAcpCheckResults(current => ({ ...current, [backend]: undefined }))
      setError(undefined)
      try {
        const view = await props.control<PluginSettingsView>('settings.get')
        applyView(view)
        const available = view.acpAvailability?.[backend] === true
        if (!available && view.writable && view.config.acp?.backends?.some(item => item.id === backend && item.enabled !== false)) {
          applyView(await props.control<PluginSettingsView>('settings.acp.set', { backend, enabled: false }))
        }
        setAcpCheckResults(current => ({ ...current, [backend]: available }))
        setNotice({ key: available ? 'acpAvailable' : 'acpUnavailable' })
        window.setTimeout(() => setAcpCheckResults(current => ({ ...current, [backend]: undefined })), 5_000)
      } catch (reason) {
        setError(messageOf(reason))
      } finally {
        setAcpChecking(current => ({ ...current, [backend]: false }))
      }
    }

    const removeAcp = async (backend: string): Promise<void> => {
      setBusy(true)
      setError(undefined)
      try {
        const view = await props.control<PluginSettingsView>('settings.acp.remove', { id: backend })
        applyView(view)
      } catch (reason) {
        setError(messageOf(reason))
      } finally {
        setBusy(false)
      }
    }

    const developmentSetting = React.createElement('section', { className: 'dshRemoteDevelopmentSettings' },
      React.createElement('div', { className: 'dshRemoteAuthorizationSetting' },
        React.createElement('div', null, React.createElement('strong', null, t('terminalRemote')),
          React.createElement('p', null, t('terminalRemoteHint'))),
        React.createElement('input', {
          type: 'checkbox', role: 'switch', checked: terminalEnabled,
          disabled: busy || terminalBusy || !writable, 'aria-label': t('terminalRemote'),
          onChange: (event: Event) => void setTerminalRemote((event.target as HTMLInputElement).checked)
        })),
      React.createElement('div', { className: 'dshRemoteAuthorizationSetting' },
        React.createElement('div', null, React.createElement('strong', null, t('remoteTools')), React.createElement('p', null, t('remoteToolsHint'))),
        React.createElement('input', { type: 'checkbox', role: 'switch', checked: remoteToolsEnabled, disabled: remoteToolsBusy || !writable, 'aria-label': t('remoteTools'), onChange: (event: Event) => { const enabled = (event.target as HTMLInputElement).checked; setRemoteToolsEnabled(enabled); void setRemoteTools(enabled) } })),
      )

    const acpSetting = React.createElement('details', { className: 'dshRemoteAuthorizationSetting dshRemoteAcpSetting' },
      React.createElement('summary', null,
        React.createElement('div', { className: 'dshRemoteAcpSummaryText' },
          React.createElement('strong', null, t('agentBackends')),
          React.createElement('p', null, t('acpHint'), React.createElement('a', {
            href: 'https://github.com/liguobao/ds-harness-remote/blob/feat/cursor-remote/docs/acp-remote.md',
            target: '_blank', rel: 'noopener noreferrer',
            onClick: (event: Event) => event.stopPropagation(),
          }, t('acpDocumentation'))))),
      React.createElement('div', { className: 'dshRemoteAcpList' }, acpBackends.map(item => React.createElement('div', { key: item.id, className: 'dshRemoteAuthorizationSetting' },
        React.createElement('div', null, React.createElement('strong', null, item.id === 'codex' ? 'CodeX' : item.id === 'cursor' ? 'Cursor' : item.id === 'antigravity' ? 'AGY' : item.id === 'claude' ? 'Claude' : item.id === 'pi' ? 'Pi' : item.id === 'opencode' ? 'OpenCode' : item.id), null),
        React.createElement('span', { className: 'dshRemoteAcpCheckCell' },
          React.createElement('a', { href: `#check-acp-${item.id}`, className: `dshRemoteAcpCheckLink${acpChecking[item.id] ? ' isChecking' : acpCheckResults[item.id] === undefined ? '' : acpCheckResults[item.id] ? ' isPassed' : ' isFailed'}`, onClick: (event: Event) => { event.preventDefault(); void checkAcp(item.id) } },
            acpChecking[item.id] ? t('checkingAcp') : acpCheckResults[item.id] === undefined ? t('checkAcp') : t(acpCheckResults[item.id] ? 'acpCheckPassed' : 'acpCheckFailed'))),
        ['codex', 'cursor', 'antigravity', 'pi', 'claude', 'opencode'].includes(item.id) ? null : React.createElement('a', { href: `#remove-acp-${item.id}`, className: 'dshRemoteAcpRemoveLink', onClick: (event: Event) => { event.preventDefault(); void removeAcp(item.id) } }, t('removeAcp')),
        React.createElement('input', {
          type: 'checkbox', role: 'switch', checked: settingsView?.config.acp?.enabled === true && item.enabled && acpAvailability[item.id] === true, 'aria-label': item.id, disabled: busy || !writable || acpChecking[item.id] === true || acpAvailability[item.id] !== true,
          onChange: (event: Event) => void props.control<PluginSettingsView>('settings.acp.set', { backend: item.id, enabled: (event.target as HTMLInputElement).checked }).then(view => { applyView(view); setAcpBackends((view.config.acp?.backends ?? []).map(v => ({ id: v.id, enabled: v.enabled !== false }))) }).catch(reason => setError(messageOf(reason)))
        }))),
        ))

    const directErrorCode = directStatus?.error
      ?? (directStatus?.tailscale.detected === false ? directStatus.tailscale.error ?? 'TAILSCALE_NOT_DETECTED' : undefined)
    const directStatusText = directStatus === undefined
      ? t('loadingSettings')
      : directStatus.running
        ? t('directRunning')
        : t('directStopped')
    const directSetting = React.createElement('section', { className: 'dshRemoteDevelopmentSettings dshRemoteDirectSettings' },
      React.createElement('div', { className: 'dshRemoteAuthorizationSetting' },
        React.createElement('div', null,
          React.createElement('strong', null, t('directTailscale')),
          React.createElement('p', null, t('directTailscaleHint')),
          React.createElement('p', null, t('directAuthorizedHint'))),
        React.createElement('input', {
          type: 'checkbox', role: 'switch', checked: directEnabled,
          disabled: busy || directBusy || !writable, 'aria-label': t('directTailscale'),
          onChange: (event: Event) => toggleDirect((event.target as HTMLInputElement).checked),
        })),
      React.createElement('div', { className: 'dshRemotePathField' },
        React.createElement('label', { htmlFor: 'dsh-remote-direct-port' }, t('directPort')),
        React.createElement('div', { className: 'dshRemotePortsRow' },
          React.createElement('input', {
            id: 'dsh-remote-direct-port', type: 'number', min: 1024, max: 65535,
            value: directPort, disabled: busy || directBusy || !writable,
            onChange: (event: Event) => setDirectPort((event.target as HTMLInputElement).value),
          }),
          React.createElement('button', {
            type: 'button',
            disabled: busy || directBusy || !writable || directPort.trim() === '',
            onClick: saveDirectPort,
          }, t('directSave')))),
      React.createElement('div', { className: 'dshRemoteDirectStatus' },
        React.createElement('i', {
          className: directStatus?.running ? 'isOn' : directErrorCode === undefined ? '' : 'isError',
          'aria-hidden': true,
        }),
        React.createElement('span', null, directStatusText)),
      !directEnabled || directStatus === undefined || !directStatus.running ? null : React.createElement('div', { className: 'dshRemotePathField' },
        React.createElement('label', null, t('directEndpoints')),
        directStatus.endpoints.length === 0
          ? React.createElement('p', null, t('directNoEndpoints'))
          : React.createElement('div', { className: 'dshRemoteDirectEndpointList' },
            directStatus.endpoints.map(endpoint => React.createElement('input', {
              key: endpoint, readOnly: true, value: endpoint, 'aria-label': t('directEndpoints'),
              onFocus: (event: Event) => (event.target as HTMLInputElement).select(),
            })))),
      directStatus?.tailscale.detected === false && directStatus.tailscale.backendState !== undefined
        ? React.createElement('p', { className: 'dshRemoteHint' }, t('directTailscaleBackend', { state: directStatus.tailscale.backendState }))
        : null,
      directErrorCode === undefined
        ? null
        : React.createElement('p', { className: 'dshRemoteError', role: 'status' }, directStatusErrorLabel(directErrorCode, t)))

    if (props.view === 'summary') return React.createElement('span', null, t('pluginDescription'))

    return React.createElement(props.view === 'page' ? 'div' : 'li', { className: `dshRemotePluginCard${open ? ' isOpen' : ''}${props.view === 'page' ? ' dshRemotePluginModern' : ''}` },
      React.createElement('div', { className: 'dshRemotePluginCardHeader' },
        React.createElement('button', {
          type: 'button',
          className: 'dshRemotePluginCardToggle',
          'aria-expanded': open,
          'aria-label': t(open ? 'collapseSettings' : 'expandSettings', { name: t('pluginTitle') }),
          onClick: () => setOpen(current => !current),
        },
          React.createElement('span', { className: 'dshRemotePluginCardHeading' },
            React.createElement('strong', null, t('pluginTitle')),
            React.createElement('span', null, t('pluginDescription'))),
          association === undefined ? null : React.createElement('span', {
            className: `dshRemotePluginCardStatus${connectionStatusClass(hostStatus)}`,
          }, hostStatus === undefined ? t('associated') : connectionStatusLabel(hostStatus, t)),
          React.createElement('span', { className: 'dshRemotePluginCardChevron', 'aria-hidden': true }, '⌄'))),
      !open ? null : React.createElement('div', { className: 'dshRemotePluginCardBody' },
        !loaded
          ? React.createElement('p', { className: 'dshRemoteSettingsState' }, error ?? t('loadingSettings'))
          : association !== undefined
            ? React.createElement('div', { className: 'dshRemoteSettings' },
              React.createElement('div', { className: 'dshRemoteSettingsTop' },
                React.createElement('div', { className: 'dshRemoteAssociation' },
                  React.createElement('span', null, t(association.account === undefined ? 'authorization' : 'account')),
                  React.createElement('strong', null, association.account
                    ?? t('authorizationComplete')),
                  React.createElement('p', null, association.account === undefined
                    ? serverUrl
                    : t('authorizedOn', { role: 'Remote', serverUrl })))),
              React.createElement('div', { className: 'dshRemoteHostIdentity' },
                React.createElement('div', null,
                  React.createElement('span', null, t('hostName')),
                  React.createElement('strong', null, hostName || '—')),
                React.createElement('div', null,
                  React.createElement('span', null, t('deviceId')),
                  React.createElement('code', null, hostDeviceId || '—'))),
              developmentSetting,
              directSetting,
              acpSetting,
              React.createElement('div', { className: 'dshRemoteAuthorizationSetting' },
                React.createElement('div', null,
                  React.createElement('strong', null, t('allowControlCurrentDevice')),
                  React.createElement('p', null, t('thisMachineHost'))),
                React.createElement('input', {
                  type: 'checkbox', role: 'switch', disabled: busy,
                  'aria-label': t('allowControlCurrentDevice'),
                  checked: hostStatus?.authorized === true,
                  onChange: (event: Event) => void setCurrentDeviceControl((event.target as HTMLInputElement).checked),
                })),
              React.createElement('div', { className: 'dshRemoteConnection', 'aria-live': 'polite' },
                React.createElement('div', { className: 'dshRemoteConnectionSummary' },
                  React.createElement('span', null, t('connection')),
                  React.createElement('strong', null,
                    React.createElement('span', {
                      className: `dshRemoteConnectionDot${connectionStatusClass(hostStatus)}`,
                      'aria-hidden': true,
                    }),
                    connectionStatusLabel(hostStatus, t)),
                  React.createElement('p', null, hostStatus === undefined
                    ? t('checkingConnection')
                    : hostStatus.lastActiveAt === undefined
                      ? t('neverConnected')
                      : t('lastActive', { time: formatLocalTime(hostStatus.lastActiveAt) }))),
                React.createElement('button', {
                  type: 'button',
                  className: 'dshRemoteReconnect',
                  disabled: reconnectBusy || hostStatus?.configured === false,
                  onClick: () => void reconnectHost(),
                }, t(reconnectBusy ? 'reconnectingAction' : 'reconnect'))),
              hostStatus?.error === undefined || hostStatus.online
                ? null
                : React.createElement('p', { className: 'dshRemoteConnectionIssue', role: 'status' }, connectionErrorMessage(hostStatus.error, t)),
              !writable ? React.createElement('p', { className: 'dshRemoteError' }, t('readOnly')) : null,
              React.createElement('div', { className: 'dshRemoteSettingsFooter' },
                React.createElement('p', {
                  className: error !== undefined ? 'dshRemoteError' : 'dshRemoteNotice',
                  role: error !== undefined ? 'alert' : 'status',
                }, error ?? (notice === undefined ? '' : t(notice.key, notice.params))),
                React.createElement('button', {
                  type: 'button',
                  className: 'dshRemoteDiscard',
                  disabled: busy || !writable,
                  onClick: () => void logout(),
                }, t(busy ? 'signingOut' : 'signOut'))))
            : React.createElement('div', { className: 'dshRemoteSettings' },
              React.createElement('div', { className: 'dshRemoteHostIdentity' },
                React.createElement('div', null,
                  React.createElement('span', null, t('hostName')),
                  React.createElement('strong', null, hostName || '—')),
                React.createElement('div', null,
                  React.createElement('span', null, t('deviceId')),
                  React.createElement('code', null, hostDeviceId || '—'))),
              developmentSetting,
              directSetting,
              acpSetting,
              React.createElement('div', { className: 'dshRemoteSettingsSignIn' },
                React.createElement('p', { className: 'dshRemoteSettingsState' }, t('authorizeFromRemote')),
                React.createElement('button', {
                  type: 'button', className: 'dshRemoteSave', disabled: busy || !loaded,
                  onClick: props.onSignIn,
                }, t('signInAccount'))),
              !writable ? React.createElement('p', { className: 'dshRemoteError' }, t('readOnly')) : null,
              error !== undefined || notice !== undefined ? React.createElement('div', { className: 'dshRemoteSettingsFooter' },
                React.createElement('p', {
                  className: error !== undefined ? 'dshRemoteError' : 'dshRemoteNotice',
                  role: error !== undefined ? 'alert' : 'status',
                }, error ?? t(notice!.key, notice!.params))) : null)))
  }

  return RemotePluginOptions
}
