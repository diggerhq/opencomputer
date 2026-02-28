# OpenSandbox Skill Examples

Real-world examples of using the OpenSandbox skill with Claude Code.

## Quick Examples

### 1. Run a Python Script

**User:**
```
Run this Python code:
print("Hello from OpenSandbox!")
```

**Claude's Actions:**
```bash
# Creates sandbox
SB=$(osb sandbox create --template python | grep "Sandbox created:" | awk '{print $3}')

# Writes code
echo 'print("Hello from OpenSandbox!")' | osb files write $SB /workspace/test.py -

# Executes
osb exec $SB python /workspace/test.py

# Output: Hello from OpenSandbox!

# Cleans up
osb sandbox kill $SB
```

---

### 2. Install Packages and Run

**User:**
```
Test if requests library works
```

**Claude's Actions:**
```bash
SB=$(osb sandbox create --template python | grep "Sandbox created:" | awk '{print $3}')

# Install requests
osb exec $SB pip install requests

# Write test code
cat << 'EOF' | osb files write $SB /tmp/test.py -
import requests
response = requests.get('https://api.github.com')
print(f"Status: {response.status_code}")
print(f"Rate limit: {response.headers.get('X-RateLimit-Limit')}")
EOF

# Run it
osb exec $SB python /tmp/test.py

osb sandbox kill $SB
```

---

### 3. Multi-File Project

**User:**
```
Create a simple Flask API with two endpoints
```

**Claude's Actions:**
```bash
SB=$(osb sandbox create --template python | grep "Sandbox created:" | awk '{print $3}')

# Install Flask
osb exec $SB pip install flask

# Create app.py
cat << 'EOF' | osb files write $SB /workspace/app.py -
from flask import Flask, jsonify

app = Flask(__name__)

@app.route('/hello')
def hello():
    return jsonify({"message": "Hello from OpenSandbox!"})

@app.route('/status')
def status():
    return jsonify({"status": "running"})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=80)
EOF

# Create test script
cat << 'EOF' | osb files write $SB /workspace/test.py -
import requests

base = 'http://localhost'
print("Testing /hello:", requests.get(f'{base}/hello').json())
print("Testing /status:", requests.get(f'{base}/status').json())
EOF

# Run Flask in background and test
osb shell $SB "python /workspace/app.py & sleep 2 && python /workspace/test.py"

osb sandbox kill $SB
```

---

### 4. Data Processing

**User:**
```
Process this CSV data with pandas
```

**Claude's Actions:**
```bash
SB=$(osb sandbox create --template python | grep "Sandbox created:" | awk '{print $3}')

osb exec $SB pip install pandas

# Write CSV data
cat << 'EOF' | osb files write $SB /workspace/data.csv -
name,age,city
Alice,30,NYC
Bob,25,LA
Charlie,35,Chicago
EOF

# Write processing script
cat << 'EOF' | osb files write $SB /workspace/process.py -
import pandas as pd

df = pd.read_csv('/workspace/data.csv')
print("Data shape:", df.shape)
print("\nAverage age:", df['age'].mean())
print("\nCities:", df['city'].unique())
print("\nData:\n", df)
EOF

osb exec $SB python /workspace/process.py

osb sandbox kill $SB
```

---

### 5. Node.js Script

**User:**
```
Test this JavaScript code with Node
```

**Claude's Actions:**
```bash
SB=$(osb sandbox create --template node | grep "Sandbox created:" | awk '{print $3}')

# Write code
cat << 'EOF' | osb files write $SB /workspace/test.js -
const fs = require('fs');

// Test file operations
fs.writeFileSync('/tmp/test.txt', 'Hello from Node!');
const content = fs.readFileSync('/tmp/test.txt', 'utf8');
console.log('File content:', content);

// Test async
setTimeout(() => {
    console.log('Async works!');
}, 100);
EOF

osb exec $SB node /workspace/test.js

osb sandbox kill $SB
```

---

### 6. Shell Scripting

**User:**
```
Create a backup script and test it
```

**Claude's Actions:**
```bash
SB=$(osb sandbox create --template ubuntu | grep "Sandbox created:" | awk '{print $3}')

# Create test files
osb shell $SB "mkdir -p /workspace/source && echo 'file1' > /workspace/source/file1.txt && echo 'file2' > /workspace/source/file2.txt"

# Write backup script
cat << 'EOF' | osb files write $SB /workspace/backup.sh -
#!/bin/bash
SOURCE="/workspace/source"
BACKUP="/workspace/backup-$(date +%Y%m%d)"

mkdir -p "$BACKUP"
cp -r "$SOURCE"/* "$BACKUP/"
echo "Backed up $(ls "$SOURCE" | wc -l) files to $BACKUP"
ls -la "$BACKUP"
EOF

osb exec $SB chmod +x /workspace/backup.sh
osb exec $SB /workspace/backup.sh

osb sandbox kill $SB
```

---

## Advanced Examples

### 7. Long-Running Development Session

**User:**
```
Create a Python sandbox for me to work in
```

**Claude:**
```bash
SB=$(osb sandbox create --template python | grep "Sandbox created:" | awk '{print $3}')
echo "Created sandbox: $SB"
echo "I'll keep this sandbox alive for our session."
```

**User:**
```
Install numpy and matplotlib
```

**Claude:**
```bash
osb exec $SB pip install numpy matplotlib
```

**User:**
```
Create a simple plot
```

**Claude:**
```bash
cat << 'EOF' | osb files write $SB /workspace/plot.py -
import numpy as np
import matplotlib.pyplot as plt

x = np.linspace(0, 10, 100)
y = np.sin(x)

plt.plot(x, y)
plt.savefig('/workspace/plot.png')
print("Plot saved to /workspace/plot.png")
EOF

osb exec $SB python /workspace/plot.py
```

**User:**
```
Clean up
```

**Claude:**
```bash
osb sandbox kill $SB
```

---

### 8. Testing Multiple Versions

**User:**
```
Test this code in both Python and Node
```

**Claude:**
```bash
# Python version
PY_SB=$(osb sandbox create --template python | grep "Sandbox created:" | awk '{print $3}')
echo 'print("Hello from Python")' | osb files write $PY_SB /tmp/test.py -
osb exec $PY_SB python /tmp/test.py

# Node version
NODE_SB=$(osb sandbox create --template node | grep "Sandbox created:" | awk '{print $3}')
echo 'console.log("Hello from Node")' | osb files write $NODE_SB /tmp/test.js -
osb exec $NODE_SB node /tmp/test.js

# Cleanup
osb sandbox kill $PY_SB
osb sandbox kill $NODE_SB
```

---

### 9. Database Operations

**User:**
```
Test SQLite operations
```

**Claude:**
```bash
SB=$(osb sandbox create --template python | grep "Sandbox created:" | awk '{print $3}')

cat << 'EOF' | osb files write $SB /workspace/db_test.py -
import sqlite3

# Create database
conn = sqlite3.connect('/tmp/test.db')
cursor = conn.cursor()

# Create table
cursor.execute('''
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)
''')

# Insert data
cursor.execute("INSERT INTO users (name, email) VALUES (?, ?)",
               ("Alice", "alice@example.com"))
cursor.execute("INSERT INTO users (name, email) VALUES (?, ?)",
               ("Bob", "bob@example.com"))
conn.commit()

# Query
cursor.execute("SELECT * FROM users")
for row in cursor.fetchall():
    print(row)

conn.close()
EOF

osb exec $SB python /workspace/db_test.py

osb sandbox kill $SB
```

---

### 10. Error Handling

**User:**
```
Test this code that might fail
```

**Claude:**
```bash
SB=$(osb sandbox create --template python | grep "Sandbox created:" | awk '{print $3}')

cat << 'EOF' | osb files write $SB /workspace/test.py -
try:
    result = 10 / 0
except ZeroDivisionError as e:
    print(f"Caught error: {e}")
    print("Handling gracefully...")
finally:
    print("Cleanup complete")
EOF

osb exec $SB python /workspace/test.py

osb sandbox kill $SB
```

---

## Tips for Best Results

1. **Always show the commands** you're running for transparency
2. **Parse sandbox IDs** from create output
3. **Use heredocs** for multi-line files
4. **Pipe content** with `-` for stdin
5. **Chain commands** with `&&` in shell commands
6. **Clean up** unless user wants to keep the sandbox
7. **Handle errors** by checking exit codes
8. **Show output** to the user after each step
