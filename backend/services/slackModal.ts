export const buildIncidentModal = (
    channelId: string,
    triggeredBy: string,
    prefillText: string = ""
) => {
    return {
        type: "modal" as const,
        callback_id: "incident_modal_submit",
        private_metadata: JSON.stringify({ channelId, triggeredBy }),
        title: {
            type: "plain_text" as const,
            text: "🚨 Start Incident Tracking"
        },
        submit: {
            type: "plain_text" as const,
            text: "Start tracking ✅"
        },
        close: {
            type: "plain_text" as const,
            text: "Cancel"
        },
        blocks: [
            {
                type: "input",
                block_id: "incident_title",
                label: {
                    type: "plain_text" as const,
                    text: "Incident Title"
                },
                element: {
                    type: "plain_text_input" as const,
                    action_id: "title_input",
                    placeholder: {
                        type: "plain_text" as const,
                        text: "e.g. DB Connection Spike"
                    },
                    initial_value: prefillText || ""
                }
            },
            {
                type: "input",
                block_id: "incident_severity",
                label: {
                    type: "plain_text" as const,
                    text: "Severity"
                },
                element: {
                    type: "static_select" as const,
                    action_id: "severity_input",
                    placeholder: {
                        type: "plain_text" as const,
                        text: "Select severity"
                    },
                    options: [
                        {
                            text: { type: "plain_text" as const, text: "🔴 High" },
                            value: "high"
                        },
                        {
                            text: { type: "plain_text" as const, text: "🟡 Medium" },
                            value: "medium"
                        },
                        {
                            text: { type: "plain_text" as const, text: "🟢 Low" },
                            value: "low"
                        }
                    ]
                }
            },
            {
                type: "input",
                block_id: "incident_description",
                label: {
                    type: "plain_text" as const,
                    text: "What is happening?"
                },
                element: {
                    type: "plain_text_input" as const,
                    action_id: "description_input",
                    multiline: true,
                    placeholder: {
                        type: "plain_text" as const,
                        text: "Describe what you are seeing..."
                    }
                }
            },
            {
                type: "input",
                block_id: "affected_service",
                label: {
                    type: "plain_text" as const,
                    text: "Affected Service"
                },
                element: {
                    type: "plain_text_input" as const,
                    action_id: "service_input",
                    placeholder: {
                        type: "plain_text" as const,
                        text: "e.g. orders-api, payments, auth-service"
                    }
                },
                optional: true
            },
            {
                type: "input",
                block_id: "incident_type",
                label: {
                    type: "plain_text" as const,
                    text: "Incident Type"
                },
                element: {
                    type: "static_select" as const,
                    action_id: "type_input",
                    placeholder: {
                        type: "plain_text" as const,
                        text: "Select type"
                    },
                    options: [
                        {
                            text: { type: "plain_text" as const, text: "🗄️ Database" },
                            value: "database"
                        },
                        {
                            text: { type: "plain_text" as const, text: "🖥️ Server" },
                            value: "server"
                        },
                        {
                            text: { type: "plain_text" as const, text: "🔌 API" },
                            value: "api"
                        },
                        {
                            text: { type: "plain_text" as const, text: "🔒 Security" },
                            value: "security"
                        },
                        {
                            text: { type: "plain_text" as const, text: "💳 Payment" },
                            value: "payment"
                        },
                        {
                            text: { type: "plain_text" as const, text: "🌐 Network" },
                            value: "network"
                        },
                        {
                            text: { type: "plain_text" as const, text: "❓ Unknown" },
                            value: "unknown"
                        }
                    ]
                },
                optional: true
            }
        ]
    };
};