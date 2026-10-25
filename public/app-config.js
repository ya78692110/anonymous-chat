const localHosts = ['localhost', '127.0.0.1', '[::1]'];
window.ANONYMOUS_CHAT_SERVER_URL = localHosts.includes(location.hostname)
	? ''
	: 'https://anonymous-chat-production-23c6.up.railway.app';
