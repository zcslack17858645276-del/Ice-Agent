# AI Desktop Pet Agent Project Development Plan

## 1. Project Overview

The goal of this project is to build an AI desktop pet system that runs on a personal computer.

This system is more than a simple chatbot. It provides:

- Desktop character display
- AI conversation capabilities
- A personality system
- Long-term memory
- Voice interaction
- Tool calling
- Automated task execution

The ultimate goal is:

> Build a personal AI assistant that runs continuously on the Windows desktop.

------------------------------------------------------------------------

# 2. Overall Architecture

The system consists of the following modules:

```
User
 |
 +----------------+
 |                |
Text Input     Voice Input
 |                |
 +----------------+
          |
          v
       AI Core
          |
 +--------+---------+
 |                  |
LLM              Memory
 |                  |
 +--------+---------+
          |
          v
      Agent System
          |
 +--------+---------+
 |                  |
Tools              MCP
          |
          v
    Desktop Pet UI
          |
          v
       Avatar
```

------------------------------------------------------------------------

# 3. Development Phases

# Phase 0: Desktop Pet Foundation

## Goal

Establish the basic structure of the desktop pet application.

## Functional Goals

- Floating desktop window
- Transparent background
- Borderless window
- Always on top
- Basic interaction

## Technical Approach

Frontend:

- TypeScript
- React / Vue
- Vite

Desktop framework:

- Tauri 2
- Rust

## Task List

### Desktop Window System

- [ ] Create the Tauri project
- [ ] Configure a transparent window
- [ ] Configure borderless mode
- [ ] Configure always-on-top behavior
- [ ] Implement window dragging

### Basic UI

- [ ] Create the desktop pet display area
- [ ] Create the chat window
- [ ] Create the settings page

## Phase Deliverable

A basic desktop pet window that can run on the desktop.

------------------------------------------------------------------------

# Phase 1: Character System

## Goal

Give the desktop pet a visual identity.

## Functional Goals

- Character display
- Animation playback
- Expression changes
- State feedback

## Technical Approach

Initial:

- PNG
- WebP
- Simple animations

Later:

- Live2D
- 3D Avatar

## Task List

### Avatar System

- [x] Character asset management
- [x] Animation control
- [x] Expression switching

### State System

Definitions:

- IDLE
- THINKING
- HAPPY
- SAD
- WORKING
- SLEEPING

Implementation:

- [x] Create a state machine
- [x] Implement state transition logic
- [x] Bind states to animations

## Phase Deliverable

The desktop pet has basic signs of life.

------------------------------------------------------------------------

# Phase 2: AI Conversation System

## Goal

Connect a large language model.

## Functional Goals

- Text chat
- Context understanding
- Personality control

## Task List

### LLM Integration

- [ ] Support OpenAI Compatible API
- [ ] Support local models
- [ ] Model configuration management

### Persona System

Implement:

- [ ] Character name
- [ ] Personality settings
- [ ] Response style
- [ ] Behavior rules

## Phase Deliverable

An AI desktop pet with a consistent personality.

------------------------------------------------------------------------

# Phase 3: Memory System

## Goal

Enable long-term companionship.

## Functional Goals

Store:

- User preferences
- Chat history
- Important events
- Usage habits

## Technical Approach

Database:

- SQLite

Vector storage:

- FAISS
- Chroma

## Task List

### Short-Term Memory

- [ ] Save recent chat history
- [ ] Automatically organize context

### Long-Term Memory

- [ ] Extract user information
- [ ] Save important events
- [ ] Vector retrieval

## Phase Deliverable

The desktop pet can remember the user.

------------------------------------------------------------------------

# Phase 4: Voice Interaction System

## Goal

Enable natural voice communication.

## System Flow

Voice input

↓

ASR

↓

LLM

↓

TTS

↓

Avatar feedback

## Task List

### ASR

- [ ] Integrate Whisper
- [ ] Real-time speech recognition

### TTS

Support:

- [ ] GPT-SoVITS
- [ ] CosyVoice

### Presentation System

- [ ] Play voice animation
- [ ] Lip synchronization
- [ ] Emotion matching

## Phase Deliverable

Voice chat is available.

------------------------------------------------------------------------

# Phase 5: Agent Capability Expansion

## Goal

Upgrade the system from a chat assistant to a task-execution assistant.

## Functional Goal

Allow the AI to call tools to complete tasks.

## Tool System

Includes:

- File management
- Software control
- Browser operations
- Automated tasks

## Task List

### File Capabilities

- [ ] File search
- [ ] File organization
- [ ] File operations

### System Control

- [ ] Open software
- [ ] Execute commands
- [ ] Read system status

### Automation

- [ ] Scheduled tasks
- [ ] Workflow execution

## Phase Deliverable

The desktop pet can operate the computer.

------------------------------------------------------------------------

# Phase 6: MCP Extension System

## Goal

Connect to the external tool ecosystem.

## Supported Directions

- Blender MCP
- VSCode MCP
- GitHub MCP
- Browser MCP

## Task List

- [ ] MCP Client
- [ ] Tool discovery
- [ ] Tool calling
- [ ] Permission management

## Phase Deliverable

An extensible AI Agent.

------------------------------------------------------------------------

# Phase 7: Advanced Intelligence System

## Goal

Enhance the sense of companionship.

## Functions

### Emotion System

- [ ] User state analysis
- [ ] AI emotion changes

### Proactive Behavior

- [ ] Proactive reminders
- [ ] Schedule management
- [ ] Task tracking

### Environmental Awareness

- [ ] Time awareness
- [ ] System state awareness

------------------------------------------------------------------------

# 4. Project Directory Plan

desktop-agent/

- frontend/
- backend/
- database/
- src-tauri/
- docs/

------------------------------------------------------------------------

# 5. Development Principles

## Incremental Development

Development order:

Desktop pet window

↓

AI chat

↓

Personality system

↓

Memory system

↓

Voice system

↓

Agent capabilities

↓

Personal assistant

## Modular Design

UI:

Responsible for display and interaction.

AI Core:

Responsible for understanding and decision-making.

Memory:

Responsible for long-term information.

Tool:

Responsible for execution.

------------------------------------------------------------------------

# 6. Ultimate Goal

Build a personal AI desktop pet that has:

> A visual identity, personality, memory, voice, and ability to act.

Final form:

Desktop Pet

-   

AI Companion

-   

Personal Agent

-   

Automation Assistant

