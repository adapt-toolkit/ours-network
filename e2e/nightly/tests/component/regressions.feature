# language: en
@known-bug @component
Feature: Focused package regressions with in-process fault injection

  @todo @preserve-file-on-interruption
  Scenario: An interrupted save_file preserves the existing file
    Given the destination file contains "ORIGINAL CONTENT"
    When MCP save_file receives an interrupted byte stream
    Then the call fails and the existing file remains unchanged

  @todo @close-codex-websocket
  Scenario: A Codex initialize timeout closes its WebSocket
    Given a test WebSocket accepts connections but does not answer initialize
    When the Codex client times out after 100 ms waiting for initialize
    Then the WebSocket connection closes within 500 ms
