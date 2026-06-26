Libraries Used:

```
- Node-fetch
    fetch api is brought to node.js
    Example usage:
        const response = await fetch('https://api.spotify.com/v1/search', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const data = await response.json();
    Used in case others are on versions of Node.js older than v18
```
