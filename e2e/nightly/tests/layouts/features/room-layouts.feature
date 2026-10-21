@layouts @native
Feature: YAML room composition without a workflow
  Scenario Outline: Shared and independent instances across rooms
    Given the public room layout CLI uses "<mode>" participants
    When the YAML layout runs through native Fleet commands
    Then native CLI assignments use <instances> distinct planned sessions
    And native successor prompts have "<history>" earlier room context
    And the native layout preserves its YAML snapshot
    And native 3-Amigos consultations admit three distinct participants with product, developer and QA roles
    And closing overlapping rooms keeps their agents alive until layout cleanup
    And native reopening detects external closure and cleanup tolerates a stopped participant
    And closing the native layout archives rooms and preserves borrowed agents

    Examples:
      | mode   | instances | history   |
      | shared | 2         | retained  |
      | fresh  | 4         | separated |
