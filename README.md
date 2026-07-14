# 📋 To-Do Kanban Board

A modern, responsive, offline-first Kanban-style To-Do application built with pure HTML, CSS, and JavaScript. Designed for personal daily productivity with drag-and-drop task management, subtasks, progress tracking, dark mode, and local data persistence.

![License](https://img.shields.io/badge/License-MIT-green)
![HTML](https://img.shields.io/badge/HTML-5-orange)
![CSS](https://img.shields.io/badge/CSS-3-blue)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6-yellow)
![License](https://img.shields.io/badge/License-MIT-green.svg)
---

## ✨ Features

### 📌 Task Management
- Create, edit and delete tasks
- Daily, In Progress and Completed columns
- Drag & Drop between columns
- Automatic task timestamps
- Due date support
- Priority levels (Low, Medium, High)
- Search tasks instantly
- Filter by Priority
- Filter by Status
- Sort by:
  - Created Date
  - Due Date
  - Priority
  - Manual Order

---

### ✅ Subtasks

Each task supports unlimited subtasks.

Features include:

- Add subtasks
- Remove subtasks
- Mark subtasks complete
- Live checklist
- Progress indicator
- Progress percentage

Example:

```
Website Redesign

☑ Create Homepage
☑ Design Dashboard
☐ Mobile Responsive
☐ Testing

Progress: 50%
```

---

### 📊 Progress Tracking

The application includes multiple progress indicators.

### Task Progress

Each task displays:

- Completed subtasks
- Remaining subtasks
- Progress bar
- Percentage completed

Example

```
3 / 5 Completed

██████████░░░░░

60%
```

### Overall Dashboard Progress

Displays:

- Total Tasks
- Daily Tasks
- In Progress Tasks
- Completed Tasks
- Completion Percentage

Example

```
Total Tasks : 20

Completed : 15

Overall Progress

██████████████████░░

75%
```

---

### 📦 Completed Information

Whenever a task is moved into **Completed**, the application records:

- Completed By
- Completed Date
- Completed Time

These values remain permanently attached to the task.

---

### 📂 Archive

- Archive completed tasks
- Restore archived tasks
- Permanent storage

---

### 💾 Offline Storage

Everything works locally.

No:

- Database
- Backend
- Login
- Internet

Data is stored using:

- LocalStorage

All changes are automatically saved.

---

### 📤 Import / Export

Export all tasks as JSON.

Import tasks back at any time.

Perfect for backups.

---

### 🎨 Themes

Supports

- ☀ Light Mode
- 🌙 Dark Mode

Theme preference is remembered.

---

### 📱 Responsive Design

Works on

- Desktop
- Laptop
- Tablet
- Mobile

---

### ⌨ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| N | New Task |
| / | Search |
| Ctrl + E | Export Tasks |
| T | Toggle Theme |
| Esc | Close Dialog |
| ? | Help |

---

## 📁 Project Structure

```
todo/
│
├── index.html
├── css/
│   └── style.css
├── js/
│   └── script.js
└── README.md
```

> If using the single-file version, the application is entirely contained within **index.html**.

---

## 🚀 Getting Started

### Clone Repository

```bash
git clone https://github.com/rakeshvadnala/todo.git
```

Open

```
index.html
```

in any browser.

No installation required.

No build process.

No dependencies.

---

## 🛠 Technologies Used

- HTML5
- CSS3
- Vanilla JavaScript (ES6)
- LocalStorage API

---

## 📸 Features Overview

✔ Drag & Drop

✔ Kanban Board

✔ Subtasks

✔ Progress Bars

✔ Overall Progress Percentage

✔ Search

✔ Filters

✔ Sorting

✔ Archive

✔ JSON Export

✔ JSON Import

✔ Dark Theme

✔ Responsive Layout

✔ Offline Ready

---

## 🎯 Future Enhancements

- Multiple Users
- Username Registration
- Calendar View
- Recurring Tasks
- Labels / Tags
- Task Attachments
- Notifications
- Reminder Alerts
- PWA Support
- IndexedDB Storage
- Cloud Sync
- GitHub Backup
- Statistics Dashboard
- Time Tracking
- Pomodoro Timer

---

## 🤝 Contributing

Contributions are welcome.

Feel free to:

- Fork the repository
- Create a feature branch
- Commit your changes
- Submit a Pull Request

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 👨‍💻 Author

**Rakesh Vadnala**

IAM Consultant | SailPoint IdentityIQ Developer | Saviynt Engineer

GitHub:
https://github.com/rakeshvadnala

LinkedIn:
https://www.linkedin.com/in/rakeshvadnala

---

⭐ If you found this project useful, consider giving it a Star on GitHub!
