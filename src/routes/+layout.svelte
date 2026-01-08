<script lang="ts">
	import { beforeNavigate, goto } from '$app/navigation';
	import { updated } from '$app/state';
	import { page } from '$app/stores';
	import { executeToolServer, getBackendConfig, getVersion } from '$lib/apis';
	import { getSessionUser, userSignOut } from '$lib/apis/auths';
	import { getChannels } from '$lib/apis/channels';
	import { getAllTags, getChatList } from '$lib/apis/chats';
	import { chatCompletion } from '$lib/apis/openai';
	import { getUserSettings } from '$lib/apis/users';
	import AppSidebar from '$lib/components/app/AppSidebar.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import NotificationToast from '$lib/components/NotificationToast.svelte';
	import { WEBUI_API_BASE_URL, WEBUI_BASE_URL } from '$lib/constants';
	import i18n, { changeLanguage, getLanguages, initI18n } from '$lib/i18n';
	import {
		WEBUI_DEPLOYMENT_ID,
		WEBUI_NAME,
		WEBUI_VERSION,
		appInfo,
		channelId,
		channels,
		chatId,
		chats,
		config,
		currentChatPage,
		isApp,
		isLastActiveTab,
		mobile,
		playingNotificationSound,
		settings,
		socket,
		tags,
		temporaryChatEnabled,
		theme,
		toolServers,
		user
	} from '$lib/stores';
	import { bestMatchingLanguage } from '$lib/utils';
	import { setTextScale } from '$lib/utils/text-scale';
	import PyodideWorker from '$lib/workers/pyodide.worker?worker';
	import dayjs from 'dayjs';
	import { io } from 'socket.io-client';
	import { onDestroy, onMount, setContext, tick } from 'svelte';
	import { spring } from 'svelte/motion';
	import { Toaster, toast } from 'svelte-sonner';

	import '../app.css';
	import '../tailwind.css';
	import 'tippy.js/dist/tippy.css';

	const loadingProgress = spring(0, {
		stiffness: 0.05
	});

	const unregisterServiceWorkers = async () => {
		if ('serviceWorker' in navigator) {
			try {
				const registrations = await navigator.serviceWorker.getRegistrations();
				await Promise.all(registrations.map((r) => r.unregister()));
				return true;
			} catch (error) {
				console.error('Error unregistering service workers:', error);
				return false;
			}
		}
		return false;
	};

	beforeNavigate(async ({ willUnload, to }) => {
		if (updated.current && !willUnload && to?.url) {
			await unregisterServiceWorkers();
			location.href = to.url.href;
		}
	});

	setContext('i18n', i18n);

	const bc = new BroadcastChannel('active-tab-channel');

	let loaded = false;
	let tokenTimer: any = null;
	let showRefresh = false;
	let heartbeatInterval: any = null;

	const BREAKPOINT = 768;

	const setupSocket = async (enableWebsocket: boolean) => {
		const _socket = io(`${WEBUI_BASE_URL}` || undefined, {
			reconnection: true,
			reconnectionDelay: 1000,
			reconnectionDelayMax: 5000,
			randomizationFactor: 0.5,
			path: '/ws/socket.io',
			transports: enableWebsocket ? ['websocket'] : ['polling', 'websocket'],
			auth: { token: localStorage.token }
		});
		await socket.set(_socket);

		_socket.on('connect_error', (err) => {
			console.log('connect_error', err);
		});

		_socket.on('connect', async () => {
			console.log('connected', _socket.id);
			const res = await getVersion(localStorage.token);

			const deploymentId = res?.deployment_id ?? null;
			const version = res?.version ?? null;

			if (version !== null || deploymentId !== null) {
				if (
					($WEBUI_VERSION !== null && version !== $WEBUI_VERSION) ||
					($WEBUI_DEPLOYMENT_ID !== null && deploymentId !== $WEBUI_DEPLOYMENT_ID)
				) {
					await unregisterServiceWorkers();
					location.reload();
					return;
				}
			}

			heartbeatInterval = setInterval(() => {
				if (_socket.connected) {
					console.log('Sending heartbeat');
					_socket.emit('heartbeat', {});
				}
			}, 30000);

			if (deploymentId !== null) {
				WEBUI_DEPLOYMENT_ID.set(deploymentId);
			}

			if (version !== null) {
				WEBUI_VERSION.set(version);
			}

			if (localStorage.getItem('token')) {
				_socket.emit('user-join', { auth: { token: localStorage.token } });
			}
		});

		_socket.on('disconnect', (reason) => {
			console.log(`Socket ${_socket.id} disconnected due to ${reason}`);
			if (heartbeatInterval) {
				clearInterval(heartbeatInterval);
				heartbeatInterval = null;
			}
		});
	};

	const executePythonAsWorker = async (id: string, code: string, cb: Function) => {
		let result: any = null;
		let stdout: any = null;
		let stderr: any = null;
		let executing = true;

		const packages = [
			/\bimport\s+requests\b|\bfrom\s+requests\b/.test(code) ? 'requests' : null,
			/\bimport\s+bs4\b|\bfrom\s+bs4\b/.test(code) ? 'beautifulsoup4' : null,
			/\bimport\s+numpy\b|\bfrom\s+numpy\b/.test(code) ? 'numpy' : null,
			/\bimport\s+pandas\b|\bfrom\s+pandas\b/.test(code) ? 'pandas' : null,
			/\bimport\s+matplotlib\b|\bfrom\s+matplotlib\b/.test(code) ? 'matplotlib' : null,
			/\bimport\s+seaborn\b|\bfrom\s+seaborn\b/.test(code) ? 'seaborn' : null,
			/\bimport\s+sklearn\b|\bfrom\s+sklearn\b/.test(code) ? 'scikit-learn' : null,
			/\bimport\s+scipy\b|\bfrom\s+scipy\b/.test(code) ? 'scipy' : null,
			/\bimport\s+re\b|\bfrom\s+re\b/.test(code) ? 'regex' : null,
			/\bimport\s+sympy\b|\bfrom\s+sympy\b/.test(code) ? 'sympy' : null,
			/\bimport\s+tiktoken\b|\bfrom\s+tiktoken\b/.test(code) ? 'tiktoken' : null,
			/\bimport\s+pytz\b|\bfrom\s+pytz\b/.test(code) ? 'pytz' : null
		].filter(Boolean);

		const pyodideWorker = new PyodideWorker();
		pyodideWorker.postMessage({ id, code, packages });

		setTimeout(() => {
			if (executing) {
				executing = false;
				stderr = 'Execution Time Limit Exceeded';
				pyodideWorker.terminate();
				if (cb) {
					cb(JSON.parse(JSON.stringify({ stdout, stderr, result }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))));
				}
			}
		}, 60000);

		pyodideWorker.onmessage = (event) => {
			const { id: _id, ...data } = event.data;
			if (data.stdout) stdout = data.stdout;
			if (data.stderr) stderr = data.stderr;
			if (data.result) result = data.result;

			if (cb) {
				cb(JSON.parse(JSON.stringify({ stdout, stderr, result }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))));
			}
			executing = false;
		};

		pyodideWorker.onerror = () => {
			if (cb) {
				cb(JSON.parse(JSON.stringify({ stdout, stderr, result }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))));
			}
			executing = false;
		};
	};

	const executeTool = async (data: any, cb: Function) => {
		const toolServer = $settings?.toolServers?.find((server: any) => server.url === data.server?.url);
		const toolServerData = $toolServers?.find((server: any) => server.url === data.server?.url);

		if (toolServer) {
			let toolServerToken = null;
			const auth_type = toolServer?.auth_type ?? 'bearer';
			if (auth_type === 'bearer') {
				toolServerToken = toolServer?.key;
			} else if (auth_type === 'session') {
				toolServerToken = localStorage.token;
			}

			const res = await executeToolServer(toolServerToken, toolServer.url, data?.name, data?.params, toolServerData);
			if (cb) cb(JSON.parse(JSON.stringify(res)));
		} else if (cb) {
			cb({ error: 'Tool Server Not Found' });
		}
	};

	const chatEventHandler = async (event: any, cb: Function) => {
		let isFocused = document.visibilityState !== 'visible';
		if (window.electronAPI) {
			const res = await window.electronAPI.send({ type: 'window:isFocused' });
			if (res) isFocused = res.isFocused;
		}

		await tick();
		const type = event?.data?.type ?? null;
		const data = event?.data?.data ?? null;

		if ((event.chat_id !== $chatId && !$temporaryChatEnabled) || isFocused) {
			if (type === 'chat:completion' && data?.done) {
				if ($settings?.notificationSoundAlways) {
					playingNotificationSound.set(true);
					new Audio('/audio/notification.mp3').play().finally(() => playingNotificationSound.set(false));
				}
				if ($isLastActiveTab && $settings?.notificationEnabled) {
					new Notification(`${data.title} • Open WebUI`, { body: data.content, icon: `${WEBUI_BASE_URL}/static/favicon.png` });
				}
				toast.custom(NotificationToast, {
					componentProps: { onClick: () => goto(`/c/${event.chat_id}`), content: data.content, title: data.title },
					duration: 15000,
					unstyled: true
				});
			} else if (type === 'chat:title') {
				currentChatPage.set(1);
				chats.set(await getChatList(localStorage.token, $currentChatPage));
			} else if (type === 'chat:tags') {
				tags.set(await getAllTags(localStorage.token));
			}
		} else if (data?.session_id === $socket?.id) {
			if (type === 'execute:python') {
				executePythonAsWorker(data.id, data.code, cb);
			} else if (type === 'execute:tool') {
				executeTool(data, cb);
			} else if (type === 'request:chat:completion') {
				const { channel, form_data, model } = data;
				try {
					const directConnections = $settings?.directConnections ?? {};
					if (directConnections) {
						const urlIdx = model?.urlIdx;
						const OPENAI_API_URL = directConnections.OPENAI_API_BASE_URLS[urlIdx];
						const OPENAI_API_KEY = directConnections.OPENAI_API_KEYS[urlIdx];
						const API_CONFIG = directConnections.OPENAI_API_CONFIGS[urlIdx];

						if (API_CONFIG?.prefix_id) {
							form_data.model = form_data.model.replace(`${API_CONFIG.prefix_id}.`, '');
						}

						const [res] = await chatCompletion(OPENAI_API_KEY, form_data, OPENAI_API_URL);
						if (res) {
							if (!res.ok) throw await res.json();
							if (form_data?.stream) {
								cb({ status: true });
								const reader = res.body.getReader();
								const decoder = new TextDecoder();
								while (true) {
									const { done, value } = await reader.read();
									if (done) break;
									const lines = decoder.decode(value, { stream: true }).split('\n').filter((l) => l.trim() !== '');
									for (const line of lines) $socket?.emit(channel, line);
								}
							} else {
								cb(await res.json());
							}
						}
					}
				} catch (error) {
					cb(error);
				} finally {
					$socket?.emit(channel, { done: true });
				}
			}
		}
	};

	const channelEventHandler = async (event: any) => {
		if (event.data?.type === 'typing') return;

		if (event.data?.type === 'channel:created') {
			const res = await getChannels(localStorage.token).catch(() => null);
			if (res) {
				channels.set(res.sort((a: any, b: any) => ['', null, 'group', 'dm'].indexOf(a.type) - ['', null, 'group', 'dm'].indexOf(b.type)));
			}
			return;
		}

		const isFocused = document.visibilityState !== 'visible';
		const onChannelPage = $page.url.pathname.includes(`/channels/${event.channel_id}`);

		if ((!onChannelPage || isFocused) && event?.user?.id !== $user?.id) {
			await tick();
			const type = event?.data?.type ?? null;
			const data = event?.data?.data ?? null;

			if ($channels) {
				if ($channels.find((ch: any) => ch.id === event.channel_id) && $channelId !== event.channel_id) {
					channels.set($channels.map((ch: any) => 
						ch.id === event.channel_id && type === 'message' 
						? { ...ch, unread_count: (ch.unread_count ?? 0) + 1, last_message_at: event.created_at } 
						: ch
					));
				} else {
					const res = await getChannels(localStorage.token).catch(() => null);
					if (res) channels.set(res.sort((a: any, b: any) => ['', null, 'group', 'dm'].indexOf(a.type) - ['', null, 'group', 'dm'].indexOf(b.type)));
				}
			}

			if (type === 'message') {
				const title = `${data?.user?.name}${event?.channel?.type !== 'dm' ? ` (#${event?.channel?.name})` : ''}`;
				if ($isLastActiveTab && $settings?.notificationEnabled) {
					new Notification(`${title} • Open WebUI`, { body: data?.content, icon: `${WEBUI_API_BASE_URL}/users/${data?.user?.id}/profile/image` });
				}
				toast.custom(NotificationToast, {
					componentProps: { onClick: () => goto(`/channels/${event.channel_id}`), content: data?.content, title },
					duration: 15000,
					unstyled: true
				});
			}
		}
	};

	const checkTokenExpiry = async () => {
		const exp = $user?.expires_at;
		const now = Math.floor(Date.now() / 1000);
		if (exp && now >= exp - 60) {
			const res = await userSignOut();
			user.set(null);
			localStorage.removeItem('token');
			location.href = res?.redirect_url ?? '/auth';
		}
	};

	onMount(async () => {
		if (import.meta.env.DEV) {
			theme.set(localStorage.theme || 'dark');
			mobile.set(window.innerWidth < BREAKPOINT);
			initI18n(localStorage?.locale || 'pt-BR');
			await config.set({
				status: true,
				name: 'Neurosia LLM (Dev)',
				version: '0.0.0-dev',
				default_locale: 'pt-BR',
				features: { enable_websocket: false, enable_signup: true, enable_login_form: true }
			} as any);
			await WEBUI_NAME.set('Neurosia LLM (Dev)');
			user.set({ id: 'dev-user', name: 'Developer', email: 'dev@neurosia.com', role: 'admin' } as any);
			document.getElementById('splash-screen')?.remove();
			loaded = true;
			return;
		}

		let touchstartY = 0;
		const isNavOrDescendant = (el: any) => {
			const nav = document.querySelector('nav');
			return nav && (el === nav || nav.contains(el));
		};

		document.addEventListener('touchstart', (e) => {
			if (isNavOrDescendant(e.target)) touchstartY = e.touches[0].clientY;
		});

		document.addEventListener('touchmove', (e) => {
			if (!isNavOrDescendant(e.target)) return;
			if (e.touches[0].clientY - touchstartY > 50 && window.scrollY === 0) {
				showRefresh = true;
				e.preventDefault();
			}
		});

		document.addEventListener('touchend', (e) => {
			if (isNavOrDescendant(e.target) && showRefresh) {
				showRefresh = false;
				location.reload();
			}
		});

		bc.onmessage = (event) => {
			if (event.data === 'active') isLastActiveTab.set(false);
		};

		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible') {
				isLastActiveTab.set(true);
				bc.postMessage('active');
				checkTokenExpiry();
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);
		handleVisibilityChange();

		const onResize = () => mobile.set(window.innerWidth < BREAKPOINT);
		window.addEventListener('resize', onResize);
		onResize();

		user.subscribe(async (value) => {
			if (value) {
				$socket?.off('events', chatEventHandler);
				$socket?.on('events', chatEventHandler);
				const userSettings = await getUserSettings(localStorage.token);
				settings.set(userSettings ? userSettings.ui : JSON.parse(localStorage.getItem('settings') ?? '{}'));
				setTextScale($settings?.textScale ?? 1);
				if (tokenTimer) clearInterval(tokenTimer);
				tokenTimer = setInterval(checkTokenExpiry, 15000);
			}
		});

		const backendConfig = await getBackendConfig().catch(() => null);
		initI18n(localStorage?.locale);

		if (backendConfig) {
			await config.set(backendConfig);
			await WEBUI_NAME.set(backendConfig.name);
			await setupSocket(backendConfig.features?.enable_websocket ?? true);

			if (localStorage.token) {
				const sessionUser = await getSessionUser(localStorage.token).catch(() => null);
				if (sessionUser) {
					user.set(sessionUser);
				} else {
					localStorage.removeItem('token');
					goto(`/auth?redirect=${encodeURIComponent(location.pathname)}`);
				}
			} else if ($page.url.pathname !== '/auth') {
				goto(`/auth?redirect=${encodeURIComponent(location.pathname)}`);
			}
		} else {
			goto('/error');
		}

		document.getElementById('splash-screen')?.remove();
		loaded = true;

		return () => window.removeEventListener('resize', onResize);
	});
</script>

<svelte:head>
	<title>{$WEBUI_NAME}</title>
	<link crossorigin="anonymous" rel="icon" href="{WEBUI_BASE_URL}/static/favicon.png" />
</svelte:head>

{#if showRefresh}
	<div class="py-5">
		<Spinner className="size-5" />
	</div>
{/if}

{#if loaded}
	{#if $isApp}
		<div class="flex flex-row h-screen">
			<AppSidebar />
			<div class="w-full flex-1 max-w-[calc(100%-4.5rem)]">
				<slot />
			</div>
		</div>
	{:else}
		<slot />
	{/if}
{/if}

<Toaster
	theme={$theme.includes('dark') ? 'dark' : $theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : 'light'}
	richColors
	position="top-right"
	closeButton
/>